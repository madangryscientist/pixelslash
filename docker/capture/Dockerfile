# syntax=docker/dockerfile:1.7
#
# The pinned PixelSlash capture image. Everything that changes how a page
# renders is fixed here: Bun, Playwright (and so Chromium) from bun.lock, and a
# bundled font set downloaded by checksum. No other fonts are left in the image.
#
#   docker build -f docker/capture/Dockerfile -t pixelslash-capture:dev .
#   docker run --rm -v "$PWD:/work" pixelslash-capture:dev capture --out snapshots
#
# Pass the image digest at run time (-e PIXELSLASH_IMAGE_DIGEST=sha256:…) and the
# fingerprint records it; without it the fingerprint records the version below.
#
# opencode is in the image for the `opencode` judge kind (PIXELSLASH_OPENCODE_MODEL).
# The model key is never baked in: pass it at run time (-e OPENCODE_API_KEY=… or a
# mounted ~/.local/share/opencode/auth.json). Nothing the capture does uses it.

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base

# The font set: Liberation 2.1.5 (metric-compatible with Arial, Times New Roman,
# Courier New), DejaVu 2.37 (wide coverage, fontconfig's default sans/serif/mono)
# and Noto Color Emoji 2.047.
FROM base AS fonts
ADD --checksum=sha256:7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0 \
    https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz /tmp/
ADD --checksum=sha256:fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7 \
    https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2 /tmp/
ADD --checksum=sha256:39ee3c587e10e89669b9ff32703261d10d5f9c4dd5ad147b6b5a1c5200591817 \
    https://github.com/googlefonts/noto-emoji/raw/v2.047/fonts/NotoColorEmoji.ttf /fonts/
RUN apt-get update \
 && apt-get install -y --no-install-recommends bzip2 \
 && tar -xzf /tmp/liberation-fonts-ttf-2.1.5.tar.gz -C /fonts --strip-components=1 --wildcards '*.ttf' \
 && tar -xjf /tmp/dejavu-fonts-ttf-2.37.tar.bz2 -C /fonts --strip-components=2 --wildcards '*/ttf/*.ttf' \
 && chmod 644 /fonts/*.ttf

# opencode, the pinned release. The tarball is @opencode/cli-linux-x64 (glibc, x86-64) from
# the npm registry, where `opencode upgrade` fetches it; the sha256 below was computed from
# that file and its sha512 matched the registry's `integrity`. To bump: change both values
# (`curl -fsSL https://registry.npmjs.org/@opencode%2fcli-linux-x64/<version>` gives the
# tarball URL; hash the download).
FROM base AS opencode
ARG OPENCODE_VERSION=2.1.4
ADD --checksum=sha256:ce05abe2dce1041391c8ec8cdb8da066f640fd471e72ac846dcb089c441e11e1 \
    https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz /tmp/opencode.tgz
RUN mkdir /opencode \
 && tar -xzf /tmp/opencode.tgz -C /opencode --strip-components=2 package/bin/opencode \
 && chmod 755 /opencode/opencode

FROM base
ARG PIXELSLASH_IMAGE_VERSION=0.1.0-dev
ENV PIXELSLASH_IMAGE_VERSION=${PIXELSLASH_IMAGE_VERSION} \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /opt/pixelslash
COPY package.json bun.lock ./
COPY packages/engine/package.json packages/engine/
COPY packages/cli/package.json packages/cli/
RUN bun install --frozen-lockfile --production

# Chromium at the version this Playwright pins, with its system libraries. The
# distro fonts that come with them are removed below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig \
 && bun packages/engine/node_modules/playwright/cli.js install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fonts /fonts/ /usr/share/fonts/pixelslash/
RUN find /usr/share/fonts -mindepth 1 -maxdepth 1 ! -name pixelslash -exec rm -rf {} + \
 && rm -rf /usr/local/share/fonts /root/.fonts /root/.local/share/fonts \
 && fc-cache -f \
 && fc-list --format '%{file}\n' | sort

COPY --from=opencode /opencode/opencode /usr/local/bin/opencode

COPY packages/engine/src packages/engine/src
COPY packages/cli/src packages/cli/src

WORKDIR /work
ENTRYPOINT ["bun", "/opt/pixelslash/packages/cli/src/index.ts"]
CMD ["capture"]
