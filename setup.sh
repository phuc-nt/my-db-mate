#!/usr/bin/env bash
# One-time setup: create .env from the example and fill in the secrets that must
# be generated locally (the credential-encryption key). Prompts for the OpenRouter
# key. Safe to re-run — it won't overwrite an existing .env.
#
# `--check` skips setup entirely and asks the running app whether the install is
# actually healthy. Setup that "succeeds" while leaving the app unable to answer a
# question is the failure this guards against.
set -euo pipefail
cd "$(dirname "$0")"

APP_URL="${APP_URL:-http://localhost:3000}"

usage() {
  cat <<'EOF'
Usage: ./setup.sh [--check] [--key <api-key>] [--no-prompt]

  (no args)     Create .env, generate the credential-encryption key, prompt for
                an OpenRouter key.
  --check       Don't set anything up — ask the running app if the install is
                healthy (app DB, migrations, LLM key, embeddings, demo dir) and
                exit non-zero if it is not. Includes a live test of the LLM key.
  --key <k>     Non-interactive: use this OpenRouter key instead of prompting.
  --no-prompt   Non-interactive: skip the key prompt entirely.
EOF
}

# ─── --check: is the install actually usable? ────────────────────────────────
run_check() {
  echo "Checking ${APP_URL} …"
  local body
  # live=1 spends one tiny completion to prove the key really works — the whole
  # point of running the check by hand.
  if ! body="$(curl -fsS --max-time 60 "${APP_URL}/api/health?live=1" 2>/dev/null)"; then
    echo "✗ Could not reach ${APP_URL}"
    echo "  Is the app running?  docker compose --profile full up -d"
    return 1
  fi

  if command -v jq >/dev/null 2>&1; then
    echo "$body" | jq -r '
      "Overall: \(.status)",
      (.checks | to_entries[] | "  \(if .value.status as $s | ["ok","configured","reachable","skipped"] | index($s) then "✓" else "✗" end) \(.key): \(.value.status)\(if .value.detail then " — \(.value.detail)" else "" end)")
    '
  else
    # jq is not a dependency of this project; raw JSON still answers the question.
    echo "$body"
  fi

  # Match the TOP-LEVEL status only. A substring match on the whole body would
  # see any nested `"status":"ok"` (appDb's, say) and call a degraded install
  # healthy — which is exactly the silent success this flag exists to prevent.
  local overall
  if command -v jq >/dev/null 2>&1; then
    overall="$(echo "$body" | jq -r '.status')"
  else
    # Depends on `status` being the first key of the JSON object, which holds
    # because it is declared first in the SetupHealth interface. If that field
    # ever moves, this yields an empty string and every install reports degraded
    # — loud, not silent, but install jq to avoid the guessing entirely.
    overall="$(echo "$body" | sed -n 's|^{"status":"\([a-z]*\)".*|\1|p')"
  fi

  if [ "$overall" = "ok" ]; then
    echo ""
    echo "✅ Install looks healthy."
    return 0
  fi
  echo ""
  echo "⚠  Install is degraded — see the failing checks above."
  return 1
}

# ─── arg parsing ─────────────────────────────────────────────────────────────
MODE="setup"
OR_KEY=""
NO_PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --key) OR_KEY="${2:-}"; shift ;;
    --no-prompt) NO_PROMPT="1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
  shift
done

if [ "$MODE" = "check" ]; then
  run_check
  exit $?
fi

# ─── setup ───────────────────────────────────────────────────────────────────
if [ -f .env ]; then
  echo ".env already exists — leaving it untouched."
  echo "Run './setup.sh --check' to verify the install is healthy."
  exit 0
fi

cp .env.example .env

# 32-byte hex key for AES-256-GCM credential encryption.
ENC_KEY="$(openssl rand -hex 32)"

# Portable in-place edit (macOS + GNU sed).
sed_i() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
sed_i "s|^CREDENTIAL_ENC_KEY=.*|CREDENTIAL_ENC_KEY=${ENC_KEY}|" .env

if [ -z "$OR_KEY" ] && [ -z "$NO_PROMPT" ]; then
  printf "\nEnter your OpenRouter API key (or leave blank to edit .env later): "
  read -r OR_KEY || true
fi

# The placeholder shipped in .env.example is a syntactically valid key, so leaving
# it in place produces an install that looks configured and fails at the provider
# on the user's first question. Blank it out so the app reports "not configured"
# and the onboarding card can say so.
if [ -n "${OR_KEY:-}" ]; then
  case "$OR_KEY" in
    sk-or-v1-*|sk-or-*) sed_i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${OR_KEY}|" .env ;;
    *)
      echo ""
      echo "⚠  That doesn't look like an OpenRouter key (expected 'sk-or-…')."
      echo "   Saving it anyway — fix it in .env or in the app's Settings page if chat fails."
      sed_i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=${OR_KEY}|" .env
      ;;
  esac
else
  sed_i "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=|" .env
fi

echo ""
echo "✅ .env created (CREDENTIAL_ENC_KEY generated)."
if [ -z "${OR_KEY:-}" ]; then
  echo "⚠  No LLM key set — chat will not work until you add one."
  echo "   Either set OPENROUTER_API_KEY in .env, or add a key in the app under Settings."
fi
echo ""
echo "Next: docker compose --profile full up -d   (app + db + auto-migrate, ${APP_URL})"
echo "Then: ./setup.sh --check                    (verify everything works)"
