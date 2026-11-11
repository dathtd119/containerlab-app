#!/usr/bin/env bash
# Starts the images-capable web image (Dockerfile.images) in local-labs mode.
# Every path is mounted at the same location inside and outside the container.
# Settings come from the environment; the defaults suit the dev host.
set -euo pipefail

NAME="${NAME:-clab-app-images-ct}"
IMAGE="${IMAGE:-containerlab-app-plus:images-dev}"
PORT="${PORT:-3101}"
CLIMG_PATH="${CLIMG_PATH:-$HOME/code/climg}"          # mounted read-only
VRNETLAB="${VRNETLAB:-$HOME/code/vrnetlab}"
CLIMG_CONFIG="${CLIMG_CONFIG:-$HOME/.config/climg-ct/config.yaml}"
CLIMG_STATE="${CLIMG_STATE:-$HOME/.local/share/climg-ct}"
IMAGES_DIR="${IMAGES_DIR:-$CLIMG_STATE/images}"
WORKSPACE="${WORKSPACE:-$HOME/.clab-ct}"
CLAB_BINARY="${CLAB_BINARY:-$(command -v containerlab)}"
CLIMG_UID="${CLIMG_UID:-$(id -u)}"
CLIMG_GID="${CLIMG_GID:-$(stat -c %g /var/run/docker.sock)}"
CLIMG_HOME="${CLIMG_HOME:-$HOME}"                     # HOME of climg in the container; the host user's, not the image's passwd
ALLOWED_HOSTS="${ALLOWED_HOSTS:-localhost,127.0.0.1,[::1]}"

mkdir -p "$WORKSPACE/ui" "$CLIMG_STATE" "$IMAGES_DIR"

docker run -d --name "$NAME" \
  --user root --privileged --network host --pid host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/run/netns:/var/run/netns \
  -v /var/lib/docker/containers:/var/lib/docker/containers \
  -v /etc/hosts:/etc/hosts \
  -v "$CLAB_BINARY":/usr/local/bin/containerlab:ro \
  -v "$CLIMG_PATH":"$CLIMG_PATH":ro \
  -v "$VRNETLAB":"$VRNETLAB" \
  -v "$(dirname "$CLIMG_CONFIG")":"$(dirname "$CLIMG_CONFIG")" \
  -v "$CLIMG_STATE":"$CLIMG_STATE" \
  -v "$IMAGES_DIR":"$IMAGES_DIR" \
  -v "$WORKSPACE":"$WORKSPACE" \
  -e PORT="$PORT" \
  -e WEB_LOCAL_LABS=true \
  -e WEB_LOCAL_WORKSPACE="$WORKSPACE" \
  -e WEB_LOCAL_CLIMG_PATH="$CLIMG_PATH/bin/climg" \
  -e WEB_LOCAL_CLIMG_CONFIG="$CLIMG_CONFIG" \
  -e WEB_LOCAL_CLIMG_STATE="$CLIMG_STATE" \
  -e WEB_LOCAL_CLIMG_USER="$CLIMG_UID:$CLIMG_GID" \
  -e WEB_LOCAL_CLIMG_HOME="$CLIMG_HOME" \
  -e WEB_ALLOWED_HOSTS="$ALLOWED_HOSTS" \
  "$IMAGE"
