#!/usr/bin/env bash
# Sets up the dose-factory Python environment.
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
echo
echo "Optional (only for generating NEW content from URLs):"
echo "  - yt-dlp on PATH"
echo "  - subs2cia (mattvsjapan fork): pip install git+https://github.com/mattvsjapan/subs2cia.git"
echo "  - export ELEVENLABS_API_KEY=..."
echo
echo "Build the demo dose (no API key needed):  python -m dose_factory demo"
