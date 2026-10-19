# Online deployment. Data (database + images + workbook) lives in /data; mount a persistent volume there.
# The full Node image has the build tools better-sqlite3 needs when no prebuilt binary is available.
ARG REGISTRY=docker.io/library
FROM ${REGISTRY}/node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM ${REGISTRY}/node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/fixtures ./server/fixtures
COPY --from=build /app/web/dist ./web/dist
VOLUME /data
EXPOSE 4310
CMD ["node", "server/dist/index.js"]
