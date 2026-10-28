# syntax=docker/dockerfile:1.7
#
# The PixelSlash self-host (PS-240): the review app and its diff worker in one image, with the
# database (D1, a SQLite file under Miniflare), the shots (R2, files under Miniflare) and the
# generated secrets on one volume at /data. Built from the repo root:
#
#   docker build -f docker/self-host/Dockerfile -t pixelslash-self-host:dev .
#
# or `docker compose up` in this directory, which does the build. Never pushed to a registry.
# Config is the container's environment; see .env.example and apps/web/README.md, "Self-host in
# 5 minutes".
#
# CLOUDFLARE_ENV is the build's wrangler env. Empty (the default) is the production build, which
# signs in only through github.com (src/auth/stub-guard.ts). `e2e` is the test build, which may be
# pointed at the GitHub stand-in: apps/web/deploy/docker/self-host.spec.ts builds it for its sign-in check, and nothing else should.

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /opt/pixelslash

FROM base AS build
ARG CLOUDFLARE_ENV=
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY packages/engine packages/engine
COPY apps/web apps/web
RUN cd apps/web && CLOUDFLARE_ENV=${CLOUDFLARE_ENV} bun run build

FROM base
ENV NODE_ENV=production \
    PIXELSLASH_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000
COPY package.json bun.lock ./
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production
COPY packages/engine/src packages/engine/src
COPY packages/engine/wasm/diff.wasm packages/engine/wasm/
COPY apps/web/src apps/web/src
COPY apps/web/deploy apps/web/deploy
COPY apps/web/drizzle apps/web/drizzle
COPY --from=build /opt/pixelslash/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
WORKDIR /opt/pixelslash/apps/web
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/`); process.exit(r.status < 500 ? 0 : 1)"]
CMD ["bun", "deploy/docker/start.ts"]
