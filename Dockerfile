# ---- build -------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only production dependencies reach the final image; the build toolchain and the
# mock server's dependencies stay behind in the build stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

# 0.0.0.0 inside the container; the published port is what controls exposure.
ENV HOST=0.0.0.0 \
    PORT=3000

USER node
EXPOSE 3000

# Reports whether this process is serving, not whether OBS is up: a container should
# not restart in a loop because somebody closed OBS.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build"]
