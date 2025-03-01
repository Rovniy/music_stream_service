# Используем Ubuntu 22.04, где Python версии >= 3.9
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# Устанавливаем необходимые пакеты
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    python3-pip \
    build-essential

# Устанавливаем Node.js LTS через nodesource
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    apt-get install -y nodejs

# Устанавливаем yt-dlp через pip
RUN pip3 install yt-dlp

# Создаем рабочую директорию
WORKDIR /app

# Копируем package.json для установки зависимостей
COPY package*.json ./
RUN npm install

# Копируем исходный код приложения
COPY . .

# Открываем порт 3000
EXPOSE 3000

# Запуск приложения
CMD ["node", "stream.js"]
