# argos-bench (ob 1476): Argos's image-comparison step, and nothing else of Argos.
#
# Built INSIDE the argos-bench VM, never on the desktop. It clones argos-ci/argos at a pinned
# commit, installs only the backend workspace (plus the root, for vitest), and adds our one
# wrapper. Their source is not modified. No Postgres, Redis, RabbitMQ or S3 is started or needed:
# diffImages only touches local files, sharp and the odiff binary.
#
#   docker build -t argos-bench .
#   docker run --rm -v /srv/bench:/work argos-bench /work/base.png /work/head.png /work/out
#   docker run --rm --network none --entrypoint /bench/self-test argos-bench   # their diff unit tests
FROM node:26-bookworm-slim

ARG ARGOS_COMMIT=21e8520c28129d501b22028a5499546b03336e38
ARG TSX_VERSION=4.23.15
ARG COREPACK_VERSION=0.36.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "corepack@${COREPACK_VERSION}" --force && corepack enable \
  && npm install -g "tsx@${TSX_VERSION}"

WORKDIR /argos
RUN git init -q . \
  && git remote add origin https://github.com/argos-ci/argos.git \
  && git fetch -q --depth 1 origin "${ARGOS_COMMIT}" \
  && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "${ARGOS_COMMIT}"

# The root (".") brings vitest for the self-test; "@argos/backend..." is the backend and the
# workspace packages it depends on. The frontend and its toolchain are not installed.
RUN pnpm install --frozen-lockfile --filter . --filter "@argos/backend..."
# The backend imports @argos/util and @argos/schemas through their dist/ exports, so build the
# backend's workspace dependencies (not the backend itself) with their own `tsdown` build.
RUN pnpm --filter "@argos/backend^..." run build

# Our wrapper sits inside their backend package so apps/backend/tsconfig.json resolves `@/*`.
COPY argos-diff.ts /argos/apps/backend/bench/argos-diff.ts
RUN printf '%s\n' '#!/bin/sh' 'set -e' 'cd /argos' \
    'exec pnpm exec vitest run --config vitest/vitest.unit.config.mts apps/backend/src/screenshot-diff/diff/image --testTimeout 30000' \
    > /bench-self-test && mkdir -p /bench && mv /bench-self-test /bench/self-test && chmod +x /bench/self-test

WORKDIR /argos/apps/backend
ENTRYPOINT ["tsx", "bench/argos-diff.ts"]
