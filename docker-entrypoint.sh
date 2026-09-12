#!/bin/sh
# Prepare the data directory before dropping privileges.
#
# A Railway volume mounted at /data arrives owned by root, which masked the
# image's build-time "chown node:node /data" and made every upload fail with
# EACCES. This entrypoint fixes ownership at boot, then drops to the
# unprivileged node user (setpriv ships with the Debian slim base image).
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR" 2>/dev/null || chmod 0777 "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
