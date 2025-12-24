FROM node:18-bullseye

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini \
    inkscape \
    fontconfig \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

RUN inkscape --version

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./

ENV NODE_ENV=production

EXPOSE 4000

ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "src/index.js"]
