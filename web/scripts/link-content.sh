#!/usr/bin/env bash
# Symlinks the repo content/ dir into public/ so Vite serves it at /content/*.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public
if [ ! -e public/content ]; then
  ln -s ../../content public/content
  echo "linked public/content -> ../../content"
else
  echo "public/content already exists"
fi
