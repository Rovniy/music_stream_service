require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const app = express();

// Configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID;
const RTMP_URL = process.env.RTMP_URL;
const TEMP_DIR = path.join(__dirname, 'temp');

// Initialize YouTube API
const youtube = google.youtube({
	version: 'v3',
	auth: YOUTUBE_API_KEY
});

// Create and clear temporary directory
async function ensureTempDir() {
	try {
		await fs.mkdir(TEMP_DIR, { recursive: true });
		const files = await fs.readdir(TEMP_DIR);
		for (const file of files) {
			await fs.unlink(path.join(TEMP_DIR, file)).catch(() => {});
		}
	} catch (error) {
		console.error('Error preparing temporary directory:', error);
	}
}

// Get video duration via yt-dlp
async function getVideoDuration(url) {
	return new Promise((resolve) => {
		exec(`yt-dlp --get-duration "${url}"`, (error, stdout, stderr) => {
			if (error || !stdout.trim()) {
				console.warn(`Error obtaining duration via yt-dlp (${url}): ${stderr}`);
				resolve(null);
			} else {
				const durationStr = stdout.trim();
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

// Get duration from file via FFmpeg
async function getFileDuration(filePath) {
	return new Promise((resolve) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) {
				console.error(`Error getting duration from file (${filePath}): ${err.message}`);
				resolve(30); // Default minimum duration
			} else {
				const duration = Math.ceil(metadata.format.duration);
				resolve(duration);
			}
		});
	});
}

// Download video using yt-dlp
async function downloadVideo(url, outputPath) {
	return new Promise((resolve, reject) => {
		exec(`yt-dlp -o "${outputPath}" -f bestvideo+bestaudio/best --no-part --no-cache-dir --merge-output-format mkv --force-overwrites "${url}"`, (error, stdout, stderr) => {
			if (error) {
				console.error(`Error downloading video (${url}): ${stderr}`);
				reject(error);
			} else {
				resolve(outputPath);
			}
		});
	});
}

// Get list of all videos from the channel
async function getChannelVideos() {
	try {
		const response = await youtube.search.list({
			part: 'id',
			channelId: CHANNEL_ID,
			maxResults: 50,
			type: 'video',
			order: 'date'
		});
		const videoIds = response.data.items.map(item => item.id.videoId);
		const videoDetails = await getVideoDetails(videoIds);

		// Фильтрация: исключаем короткие видео (Shorts) и подкасты
		return videoDetails.filter(video => {
			const durationSec = parseDuration(video.duration);
			// Если длительность меньше 60 секунд, считаем видео шортом
			if (durationSec < 60) return false;
			if (durationSec > 300) return false;

			// Если в названии содержится слово "подкаст" или "podcast" (без учёта регистра) – исключаем
			const titleLower = video.title.toLowerCase();
			if (titleLower.includes('live') || titleLower.includes('podcast')) return false;

			// Остальные видео оставляем
			return true;
		});
	} catch (error) {
		console.error('Error fetching video list:', error);
		return [];
	}
}

// Get detailed information about videos
async function getVideoDetails(videoIds) {
	try {
		const response = await youtube.videos.list({
			part: 'contentDetails,snippet',
			id: videoIds.join(',')
		});
		return response.data.items.map(item => ({
			url: `https://www.youtube.com/watch?v=${item.id}`,
			title: item.snippet.title,
			duration: item.contentDetails.duration || 'PT0S'
		}));
	} catch (error) {
		console.error('Error fetching video details:', error);
		return [];
	}
}

// Parse ISO 8601 duration or other formats into seconds
function parseDuration(duration) {
	if (!duration || typeof duration !== 'string') {
		console.warn('Invalid duration format, returning 0:', duration);
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
		console.warn('Non-standard duration format, returning 0:', duration);
		return 0;
	}

	console.warn('Failed to parse duration, returning 0:', duration);
	return 0;
}

// Shuffle an array (Fisher-Yates algorithm)
function shuffleArray(array) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

// Create stream
async function startStreaming() {
	await ensureTempDir();
	const videos = await getChannelVideos();

	if (videos.length === 0) {
		console.error('Failed to fetch videos for streaming');
		return;
	}

	const playlist = await Promise.all(videos.map(async video => {
		let duration = parseDuration(video.duration);
		if (duration === 0) {
			duration = await getVideoDuration(video.url) || 30;
		}
		return {
			url: video.url,
			title: video.title,
			duration
		};
	}));

	// Shuffle playlist
	const shuffledPlaylist = shuffleArray([...playlist]);

	async function streamVideos(index = 0, retries = 3) {
		if (index >= shuffledPlaylist.length) {
			return streamVideos(0, retries);
		}

		const currentVideo = shuffledPlaylist[index];
		const currentFile = path.join(TEMP_DIR, `video_${index}_${Date.now()}.mkv`);
		console.log(`Now streaming: ${currentVideo.title} (${currentVideo.url})`);
		console.log(`File: ${currentFile}`);
		console.log(`Preliminary video duration: ${currentVideo.duration} seconds`);

		let attempt = 0;

		async function tryDownloadAndStream() {
			try {
				// Clean up before download
				await fs.unlink(currentFile).catch(() => {});

				// Download current video
				await downloadVideo(currentVideo.url, currentFile);

				// Get exact duration from file
				const accurateDuration = await getFileDuration(currentFile);
				console.log(`Exact video duration: ${accurateDuration} seconds`);

				// Stream current video
				const startTime = Date.now();
				await new Promise((resolve) => {
					const proc = ffmpeg(currentFile)
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
						.output(RTMP_URL)
						.on('error', (err) => {
							console.error('FFmpeg error:', err.message);
							resolve();
						})
						.on('end', () => {
							resolve();
						});

					proc.run();

					// Preload next video after streaming starts
					if (index + 1 < shuffledPlaylist.length) {
						const nextVideo = shuffledPlaylist[index + 1];
						const nextFile = path.join(TEMP_DIR, `video_${index + 1}_${Date.now()}.mkv`);
						downloadVideo(nextVideo.url, nextFile).catch(err => {
							console.error(`Error preloading next video (${nextVideo.url}):`, err);
						});
					}
				});

				// Wait for the full video duration
				const elapsedTime = (Date.now() - startTime) / 1000;
				const remainingTime = Math.max(accurateDuration - elapsedTime, 0);
				if (remainingTime > 0) {
					console.log(`Waiting for playback to complete: ${remainingTime} seconds`);
					await new Promise(resolve => setTimeout(resolve, remainingTime * 1000));
				} else {
					console.log('Playback finished earlier than expected');
				}

				console.log(`Switching to next video after ${elapsedTime} seconds of playback`);

				// Remove current file after streaming
				await fs.unlink(currentFile).catch(err => console.error('Error deleting file:', err));

				// Proceed to next video
				await streamVideos(index + 1, retries);
			} catch (error) {
				attempt++;
				if (attempt < retries) {
					console.warn(`Attempt ${attempt + 1} of ${retries} for video (${currentVideo.url})`);
					await fs.unlink(currentFile).catch(() => {});
					await new Promise(resolve => setTimeout(resolve, 10000));
					await tryDownloadAndStream();
				} else {
					console.error('All attempts exhausted, skipping video:', currentVideo.url);
					await fs.unlink(currentFile).catch(() => {});
					await streamVideos(index + 1, retries);
				}
			}
		}

		await tryDownloadAndStream();
	}

	await streamVideos(0);
}

// Start server
app.listen(3000, () => {
	startStreaming();
});
