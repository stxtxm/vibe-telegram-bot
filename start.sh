#!/usr/bin/env bash
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$PATH"
exec node dist/index.js
