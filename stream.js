require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const app = express();

// **Configuration**
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RTMP_URL = process.env.RTMP_URL;
const TEMP_DIR = path.join(__dirname, 'temp');

// **Initialize YouTube API client**
const youtube = google.youtube({
	version: 'v3',
	auth: YOUTUBE_API_KEY
});

// **Simple logger with timestamps**
function timestamp() {
	return new Date().toISOString();
}
const log = {
	info: (...args) => console.log(`[${timestamp()}] [INFO]`, ...args),
	warn: (...args) => console.warn(`[${timestamp()}] [WARN]`, ...args),
	error: (...args) => console.error(`[${timestamp()}] [ERROR]`, ...args)
};

// **Create and clear temporary directory**
async function ensureTempDir() {
	try {
		await fs.mkdir(TEMP_DIR, { recursive: true });
		const files = await fs.readdir(TEMP_DIR);
		for (const file of files) {
			await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
		}
		log.info('Temporary directory prepared:', TEMP_DIR);
	} catch (error) {
		log.error('Error preparing temporary directory:', error);
	}
}

// **Get video duration via yt-dlp using spawn**
async function getVideoDuration(url) {
	return new Promise((resolve) => {
		const ytProcess = spawn('yt-dlp', ['--get-duration', url]);
		let output = '';
		let errorOutput = '';
		ytProcess.stdout.on('data', (data) => {
			output += data.toString();
		});
		ytProcess.stderr.on('data', (data) => {
			errorOutput += data.toString();
		});
		ytProcess.on('close', (code) => {
			if (code !== 0 || !output.trim()) {
				log.warn(`Error obtaining duration via yt-dlp for ${url}: ${errorOutput.trim()}`);
				resolve(null);
			} else {
				const durationStr = output.trim();
				const parts = durationStr.split(':');
				let seconds = 0;
				if (parts.length === 3) {
					seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
				} else if (parts.length === 2) {
					seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
				} else if (parts.length === 1) {
					seconds = parseInt(parts[0]);
				}
				resolve(seconds || null);
			}
		});
	});
}

// **Get duration from file using FFprobe**
async function getFileDuration(filePath) {
	return new Promise((resolve) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) {
				log.error(`Error getting duration from file (${filePath}): ${err.message}`);
				resolve(30); // Default to 30 seconds
			} else {
				const duration = Math.ceil(metadata.format.duration);
				resolve(duration);
			}
		});
	});
}

// **Download video using yt-dlp**
async function downloadVideo(url, outputPath) {
	return new Promise((resolve, reject) => {
		const args = [
			'-o', outputPath,
			'-f', 'bestvideo+bestaudio/best',
			'--no-part',
			'--no-cache-dir',
			'--merge-output-format', 'mkv',
			'--force-overwrites',
			url
		];
		const dlProcess = spawn('yt-dlp', args);
		let errorOutput = '';
		dlProcess.stderr.on('data', data => {
			errorOutput += data.toString();
		});
		dlProcess.on('close', (code) => {
			if (code !== 0) {
				log.error(`Error downloading video ${url}: ${errorOutput.trim()}`);
				reject(new Error(`Download failed for ${url}`));
			} else {
				log.info(`Download completed: ${outputPath}`);
				resolve(outputPath);
			}
		});
	});
}

// **Fetch list of videos from the channel**
async function getChannelVideos() {
	try {
		const response = await youtube.search.list({
			part: 'id',
			channelId: CHANNEL_ID,
			maxResults: 50,
			type: 'video',
			order: 'date'
		});
		if (!response.data || !response.data.items) {
			throw new Error('No data returned from YouTube API');
		}
		const videoIds = response.data.items.map(item => item.id.videoId);
		const videoDetails = await getVideoDetails(videoIds);
		const filtered = videoDetails.filter(video => {
			const durationSec = parseDuration(video.duration);
			if (durationSec < 60 || durationSec > 300) return false;
			const titleLower = video.title.toLowerCase();
			if (titleLower.includes('live') || titleLower.includes('podcast')) return false;
			return true;
		});
		log.info(`Fetched ${filtered.length} videos from channel`);
		return filtered;
	} catch (error) {
		log.error('Error fetching video list from YouTube API:', error);
		return [];
	}
}

// **Get detailed information about videos**
async function getVideoDetails(videoIds) {
	try {
		const response = await youtube.videos.list({
			part: 'contentDetails,snippet',
			id: videoIds.join(',')
		});
		if (!response.data || !response.data.items) {
			throw new Error('No video details returned from YouTube API');
		}
		return response.data.items.map(item => ({
			url: `https://www.youtube.com/watch?v=${item.id}`,
			title: item.snippet.title,
			duration: item.contentDetails.duration || 'PT0S'
		}));
	} catch (error) {
		log.error('Error fetching video details from YouTube API:', error);
		return [];
	}
}

// **Parse ISO 8601 duration into seconds**
function parseDuration(duration) {
	if (!duration || typeof duration !== 'string') {
		log.warn('Invalid duration format, defaulting to 0:', duration);
		return 0;
	}
	const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
	if (match) {
		const hours = parseInt(match[1]) || 0;
		const minutes = parseInt(match[2]) || 0;
		const seconds = parseInt(match[3]) || 0;
		return hours * 3600 + minutes * 60 + seconds;
	}
	if (duration === 'P0D' || duration.startsWith('P')) {
		log.warn('Non-standard duration format, defaulting to 0:', duration);
		return 0;
	}
	log.warn('Failed to parse duration, defaulting to 0:', duration);
	return 0;
}

// **Shuffle an array using the Fisher-Yates algorithm**
function shuffleArray(array) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

// **Global state for managing streaming**
let activeDownloadProcess = null;
let currentFFmpegProcess = null;
let nextDownloadPromise = null;
let nextVideoIndex = null;
let nextVideoPath = null;
let shuttingDown = false;

// **Main streaming function**
async function startStreaming() {
	await ensureTempDir();
	const videos = await getChannelVideos();
	if (videos.length === 0) {
		log.error('No videos available for streaming. Exiting startStreaming.');
		return;
	}

	// Prepare playlist with determined durations
	const playlist = [];
	for (const video of videos) {
		let durationSec = parseDuration(video.duration);
		if (durationSec === 0) {
			durationSec = await getVideoDuration(video.url) || 30;
		}
		playlist.push({
			url: video.url,
			title: video.title,
			duration: durationSec
		});
	}

	// Shuffle playlist for random order
	const shuffledPlaylist = shuffleArray([...playlist]);
	log.info(`Playlist prepared with ${shuffledPlaylist.length} videos. Starting stream...`);

	async function streamVideos(index = 0, retries = 3) {
		if (shuttingDown) {
			log.warn('Streaming halted due to shutdown request.');
			return;
		}
		if (index >= shuffledPlaylist.length) {
			log.info('Reached end of playlist, looping back to start.');
			return streamVideos(0, retries);
		}

		const currentVideo = shuffledPlaylist[index];
		const currentFile = path.join(TEMP_DIR, `video_${index}.mkv`);
		log.info(`\n=== Now streaming: "${currentVideo.title}" (${currentVideo.url}) ===`);
		log.info(`Target file: ${currentFile}`);
		log.info(`Planned video duration: ${currentVideo.duration} seconds`);

		let attempt = 0;
		async function tryDownloadAndStream() {
			try {
				await fs.unlink(currentFile).catch(() => {});
				if (nextDownloadPromise && nextVideoIndex === index) {
					log.info(`Using preloaded file for video at index ${index}`);
					await nextDownloadPromise;
					nextDownloadPromise = null;
				} else {
					log.info(`Downloading video: ${currentVideo.url}`);
					activeDownloadProcess = null;
					const outputPath = await downloadVideo(currentVideo.url, currentFile);
					activeDownloadProcess = null;
				}
				const accurateDuration = await getFileDuration(currentFile);
				log.info(`Exact video duration (from file): ${accurateDuration} seconds`);

				const startTime = Date.now();
				await new Promise((resolve, reject) => {
					const command = ffmpeg(currentFile)
						.inputOptions('-re')
						.outputOptions([
							'-c:v libx264',
							'-preset veryfast',
							'-r 30',
							'-g 60',
							'-b:v 2000k',
							'-c:a aac',
							'-b:a 128k',
							'-f flv'
						])
						.output(RTMP_URL);

					command.on('error', (err) => {
						log.error('FFmpeg error during streaming:', err.message);
						resolve();
					});
					command.on('start', (cmdLine) => {
						log.info('FFmpeg process started:', cmdLine);
					});
					command.on('end', () => {
						log.info('FFmpeg process ended normally for video:', currentVideo.url);
						resolve();
					});

					currentFFmpegProcess = command;
					command.run();

					if (shuttingDown) return;
					let nextIndex = (index + 1) % shuffledPlaylist.length;
					if (shuffledPlaylist.length > 0 && nextIndex !== index) {
						const nextVideo = shuffledPlaylist[nextIndex];
						nextVideoIndex = nextIndex;
						nextVideoPath = path.join(TEMP_DIR, `video_${nextIndex}.mkv`);
						log.info(`Preloading next video: "${nextVideo.title}" at index ${nextIndex}`);
						nextDownloadPromise = downloadVideo(nextVideo.url, nextVideoPath).catch(err => {
							log.error(`Error preloading next video ${nextVideo.url}: ${err.message}`);
							throw err;
						});
					}
				});

				const elapsedTime = (Date.now() - startTime) / 1000;
				const remainingTime = Math.max(accurateDuration - elapsedTime, 0);
				if (remainingTime > 1) {
					log.info(`Waiting ${remainingTime.toFixed(2)} seconds to synchronize with video duration`);
					await new Promise(res => setTimeout(res, remainingTime * 1000));
				} else {
					log.info('No synchronization wait needed (playback duration met or exceeded expected length)');
				}

				await fs.unlink(currentFile).catch(err => log.error('Error deleting temp file:', err));
				log.info(`Finished streaming "${currentVideo.title}". Moving to next video...`);
				await streamVideos(index + 1, retries);
			} catch (error) {
				attempt++;
				if (attempt < retries) {
					log.warn(`Attempt ${attempt} failed for video ${currentVideo.url}. Retrying (attempt ${attempt + 1} of ${retries})...`);
					if (nextDownloadPromise && nextVideoIndex === index + 1) {
						if (activeDownloadProcess) {
							try {
								activeDownloadProcess.kill();
								log.warn('Aborted preloading of next video due to retry.');
							} catch (killErr) {
								log.error('Error aborting preloading process:', killErr);
							}
						}
						if (nextVideoPath) {
							await fs.unlink(nextVideoPath).catch(() => {});
						}
						nextDownloadPromise = null;
						nextVideoIndex = null;
						nextVideoPath = null;
					}
					await fs.unlink(currentFile).catch(() => {});
					await new Promise(res => setTimeout(res, 10000));
					await tryDownloadAndStream();
				} else {
					log.error(`All ${retries} attempts failed for video: ${currentVideo.url}. Skipping this video.`);
					await fs.unlink(currentFile).catch(() => {});
					await streamVideos(index + 1, retries);
				}
			} finally {
				currentFFmpegProcess = null;
			}
		}

		await tryDownloadAndStream();
	}

	await streamVideos(0);
}

// **Start the Express server and streaming**
const server = app.listen(3000, () => {
	log.info('Express server is running on port 3000. Starting RTMP streaming...');
	startStreaming().catch(err => {
		log.error('Unhandled error in startStreaming:', err);
	});
});

// **Graceful shutdown handling**
async function gracefulShutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	log.warn('Received shutdown signal. Shutting down gracefully...');
	server.close(() => {
		log.info('HTTP server closed.');
	});
	if (currentFFmpegProcess) {
		try {
			currentFFmpegProcess.kill('SIGINT');
			log.info('Sent SIGINT to FFmpeg process.');
		} catch (err) {
			log.error('Error sending SIGINT to FFmpeg process:', err);
		}
	}
	if (activeDownloadProcess) {
		try {
			activeDownloadProcess.kill('SIGINT');
			log.info('Terminated active download process.');
		} catch (err) {
			log.error('Error terminating download process:', err);
		}
	}
	setTimeout(async () => {
		await ensureTempDir().catch(() => {});
		log.info('Temporary files cleaned up. Exiting now.');
		process.exit(0);
	}, 5000).unref();
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
