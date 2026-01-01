# Build stage: install deps and compile server + client
FROM node:20-bookworm AS builder
WORKDIR /app

# Workspace manifests first (better caching)
COPY package.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json

RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Runtime image
FROM node:20-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production

# yt-dlp needs Python >=3.10 and a JS runtime for signature solving
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		python3 \
		python3-pip \
		ffmpeg \
	&& pip3 install --break-system-packages yt-dlp yt-dlp-ejs \
	&& rm -rf /var/lib/apt/lists/*

# Copy built artifacts and deps
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server/package.json ./server/package.json
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

EXPOSE 4000
CMD ["node", "server/dist/index.js"]
