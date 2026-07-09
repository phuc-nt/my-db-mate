#!/usr/bin/env bash
# One-time setup: create .env from the example and fill in the secrets that must
# be generated locally (the credential-encryption key). Prompts for the OpenRouter
# key. Safe to re-run — it won't overwrite an existing .env.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists — leaving it untouched."
  exit 0
fi

cp .env.example .env

# 32-byte hex key for AES-256-GCM credential encryption.
ENC_KEY="$(openssl rand -hex 32)"

# Portable in-place edit (macOS + GNU sed).
sed_i() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
sed_i "s|^CREDENTIAL_ENC_KEY=.*|CREDENTIAL_ENC_KEY=${ENC_KEY}|" .env

printf "\nEnter your OpenRouter API key (or leave blank to edit .env later): "
read -r OR_KEY || true
if [ -n "${OR_KEY:-}" ]; then
  sed_i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${OR_KEY}|" .env
fi

echo ""
echo "✅ .env created (CREDENTIAL_ENC_KEY generated)."
[ -z "${OR_KEY:-}" ] && echo "⚠  Set OPENROUTER_API_KEY in .env before running."
echo ""
echo "Next: docker compose --profile full up   (app + db + auto-migrate, http://localhost:3000)"
