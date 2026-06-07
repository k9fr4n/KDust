#!/usr/bin/env bash
# Install the manually-pinned, non-apt CLI tools for the KDust runner image
# (ADR-0032). Versions are read from docker/tool-versions.env — the single
# source of truth. Adding or bumping a tool = edit that file, not this script.
#
# Pure rearrangement of what used to live inline in the Dockerfile runner
# stage: same tools, same versions, same install layout (/usr/local/bin/*,
# /usr/lib/code-server). Build-time only; runs as root during `docker build`.
#
# @devcontainers/cli (npm) is NOT handled here on purpose: it keeps its own
# RUN in the Dockerfile to preserve the npm cache mount, but reads its version
# from tool-versions.env all the same.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tool-versions.env
. "${SCRIPT_DIR}/tool-versions.env"

ARCH="$(dpkg --print-architecture)"   # amd64 | arm64
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# Map the dpkg arch onto the Rust target triple Astral uses for ruff/uv assets.
rust_triple() {
  case "$1" in
    amd64) echo x86_64-unknown-linux-gnu ;;
    arm64) echo aarch64-unknown-linux-gnu ;;
    *) echo "unsupported arch: $1" >&2; exit 1 ;;
  esac
}

echo "==> Installing pinned CLI tools for arch=${ARCH}"

# ---- yq (Mike Farah's Go version) — tag carries a leading 'v' ----
echo "    yq ${YQ_VERSION}"
curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_${ARCH}" \
  -o /usr/local/bin/yq
chmod 0755 /usr/local/bin/yq

# ---- glab (GitLab CLI) — release path 'v<VER>', file name '<VER>' ----
echo "    glab ${GLAB_VERSION}"
curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb" \
  -o "${TMP}/glab.deb"
dpkg -i "${TMP}/glab.deb"

# ---- ruff (Astral) — tag has NO leading 'v' ----
echo "    ruff ${RUFF_VERSION}"
RUFF_TRIPLE="$(rust_triple "${ARCH}")"
curl -fsSL "https://github.com/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-${RUFF_TRIPLE}.tar.gz" \
  -o "${TMP}/ruff.tar.gz"
tar -xzf "${TMP}/ruff.tar.gz" -C "${TMP}"
install -m 0755 "${TMP}/ruff-${RUFF_TRIPLE}/ruff" /usr/local/bin/ruff

# ---- uv / uvx (Astral) — tag has NO leading 'v' ----
echo "    uv ${UV_VERSION}"
UV_TRIPLE="$(rust_triple "${ARCH}")"
curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TRIPLE}.tar.gz" \
  -o "${TMP}/uv.tar.gz"
tar -xzf "${TMP}/uv.tar.gz" -C "${TMP}"
install -m 0755 "${TMP}/uv-${UV_TRIPLE}/uv"  /usr/local/bin/uv
install -m 0755 "${TMP}/uv-${UV_TRIPLE}/uvx" /usr/local/bin/uvx

# ---- code-server (Coder) — standalone tarball bundling its own Node ----
echo "    code-server ${CODE_SERVER_VERSION}"
curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${ARCH}.tar.gz" \
  -o "${TMP}/code-server.tar.gz"
mkdir -p /usr/lib/code-server
tar -xzf "${TMP}/code-server.tar.gz" -C /usr/lib/code-server --strip-components=1
ln -sf /usr/lib/code-server/bin/code-server /usr/local/bin/code-server

echo "==> Pinned CLI tools installed."
