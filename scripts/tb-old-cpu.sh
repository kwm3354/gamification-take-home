#!/usr/bin/env bash
# Workaround for CPUs without AVX2 (the official TigerBeetle builds, including the native module
# inside tigerbeetle-node, need it and exit with "illegal instruction" otherwise).
# Puts a locally built native module into node_modules and prints the server binary to use.
# Not needed on a normal machine. See TB_OLDCPU_DIR/README.md for how the build was made.
set -euo pipefail
dir="${TB_OLDCPU_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/tigerbeetle-oldcpu}"
if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
  echo "This CPU has AVX2: the official builds work, nothing to do."
  exit 0
fi
[ -x "$dir/tigerbeetle" ] || { echo "No local build in $dir" >&2; exit 1; }
for platform in x86_64-linux-gnu x86_64-linux-musl; do
  target="node_modules/tigerbeetle-node/dist/bin/$platform/client.node"
  [ -f "$target" ] && cp "$dir/node-client/$platform/client.node" "$target"
done
echo "Native module replaced. Use this server binary:"
echo "  export TB_BIN=$dir/tigerbeetle"

# A local image for docker-compose.yml, laid out like the official one (alpine, /tigerbeetle).
if command -v docker >/dev/null; then
  docker build -q -t tigerbeetle-oldcpu:0.17.9 -f - "$dir" <<'DOCKERFILE'
FROM alpine:3.20
COPY tigerbeetle /tigerbeetle
ENTRYPOINT ["/tigerbeetle"]
DOCKERFILE
  echo "Image tigerbeetle-oldcpu:0.17.9 built. Switch the image line of the tigerbeetle service in docker-compose.yml."
fi
