FROM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

FROM dependencies AS emulator-sources
COPY scripts/vendor-emulator* ./scripts/
RUN node scripts/vendor-emulator.mjs prepare /emulator

# One fixed, single-threaded GB/GBA core. Sources are fetched with SHA-256
# verification above; compilation itself needs no network or commercial BIOS.
FROM emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65 AS emulator-build
WORKDIR /work
COPY --from=emulator-sources /emulator /work
RUN --network=none bash /work/vendor-emulator-build.sh

FROM dependencies AS backend
COPY backend ./backend
COPY tests ./tests
RUN npm run build --workspace backend
RUN mkdir -p /data/catalog/roms /data/catalog/covers && chown -R node:node /data/catalog && chmod 0700 /data/catalog /data/catalog/roms /data/catalog/covers
USER node
ENV NODE_ENV=production
CMD ["npm", "run", "start", "--workspace", "backend"]

FROM dependencies AS frontend
COPY frontend ./frontend
COPY --from=emulator-build /work/public ./frontend/public/emulator
RUN npm run build --workspace frontend
RUN mkdir -p node_modules/.vite-temp && chown -R node:node frontend node_modules/.vite-temp
USER node
CMD ["npm", "run", "dev", "--workspace", "frontend"]

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS browser
COPY --from=dependencies /usr/local /usr/local
WORKDIR /app
COPY --from=backend --chown=pwuser:pwuser /app /app
COPY --chown=pwuser:pwuser frontend ./frontend
COPY --from=emulator-build --chown=pwuser:pwuser /work/public ./frontend/public/emulator
COPY --chown=pwuser:pwuser scripts ./scripts
COPY --chown=pwuser:pwuser playwright.config.ts ./
RUN chown pwuser:pwuser /app
USER pwuser
ENV NODE_ENV=test
CMD ["npx", "playwright", "test"]
