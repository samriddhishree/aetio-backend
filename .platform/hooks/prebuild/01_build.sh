#!/usr/bin/env bash
set -euo pipefail

cd /var/app/staging
npm install --include=dev
npm run build
npm prune --omit=dev
