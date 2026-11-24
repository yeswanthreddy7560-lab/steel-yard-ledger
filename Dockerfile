# Steel Yard Ledger — production container.
#
# Node 22.5+ is required. Application data lives in Google Firestore, so the
# container is fully disposable: /data only holds the service account (or use
# FIREBASE_SERVICE_ACCOUNT_JSON), the session secret, logs, and JSON backups.

FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server.js start.js data.js ./
COPY src ./src
COPY public ./public
COPY views ./views
COPY scripts ./scripts

# Persistent files (optional volume) live outside the image.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "start.js"]
