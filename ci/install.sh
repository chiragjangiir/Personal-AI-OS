#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
suite=$1
backend=01-product-half-finished/backend
mkdir -p .scratch
if [[ ! -d .scratch/hermes-source ]]; then
  node integrations/hermes/verify-producer.mjs --keep .scratch/hermes-source
fi
node integrations/hermes/verify-producer.mjs --check-running .scratch/hermes-source
# Executor fixtures start the Integration payment bridge and its data authority.
npm exec --yes --package=pnpm@11.9.0 -- pnpm --dir "$backend/services/platform-data" install --frozen-lockfile
npm ci --prefix "$backend/services/personal-aios-integration"
npm ci --prefix "$backend/services/qwen-embedded"
if [[ $suite == executor ]]; then
  python3 -m venv .scratch/executor-venv
  .scratch/executor-venv/bin/python -m pip install --require-hashes -r integrations/connectors/phone_executor/requirements.lock.txt
else
  python3 -m venv .scratch/hermes-venv
  .scratch/hermes-venv/bin/python -m pip install -e '.scratch/hermes-source[dev,bedrock]' \
    mijiaAPI==5.0.0 qrcode==8.2 aiohttp==3.14.3 Pillow==12.3.0 openpyxl==3.1.5 \
    numpy==2.0.2 'opencv-python-headless~=5.0.0'
  npm exec --yes --package=pnpm@11.9.0 -- pnpm --dir "$backend/phase0/gateway" install --frozen-lockfile
fi
