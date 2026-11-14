# Build from the repo root:  docker build -f deploy/Dockerfile -t auto-curator .
FROM node:22-bookworm-slim

# ffmpeg: video rendering and probing. python3/yt-dlp: downloader for source videos. fontconfig: fonts for the card renderer.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates fontconfig \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# bun is the package manager; the runtime stays Node 22 (tsx, node:sqlite)
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN bun install --frozen-lockfile
COPY templates ./templates
# profiles/ (profile.json, style-guide.md, .env) is mounted by compose, never baked into the image

# state (SQLite, renders, downloaded media) lives in /data: mount a volume there
ENV CURADOR_DATA_DIR=/data \
    NODE_ENV=production \
    LOG_LEVEL=info \
    PROFILE=
RUN mkdir -p /data /app/profiles && chown node:node /data
VOLUME ["/data"]

# no HTTP port is exposed: Telegram uses long polling (outbound only)
USER node
CMD ["sh", "-c", "exec bun run start --profile \"${PROFILE:?defina PROFILE (id do perfil em /app/profiles)}\""]
