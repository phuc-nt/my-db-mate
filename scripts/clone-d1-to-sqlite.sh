#!/usr/bin/env bash
# Clone a Cloudflare D1 database (remote) into a local SQLite .db for use as a
# My DB Mate test/dogfood connection. Requires `wrangler login`.
#
# Usage: clone-d1-to-sqlite.sh <d1-database-name> <output.db> [wrangler-project-dir]
#   e.g. scripts/clone-d1-to-sqlite.sh vietnam-beat /path/to/vietnam-beat.db ../my-vietnam-beat/app
set -euo pipefail

DB_NAME="${1:?d1 database name required}"
OUT_DB="${2:?output .db path required}"
PROJECT_DIR="${3:-.}"
TMP_SQL="$(mktemp -t d1-export-XXXX).sql"

echo "Exporting D1 '$DB_NAME' (remote) → $TMP_SQL"
( cd "$PROJECT_DIR" && npx wrangler d1 export "$DB_NAME" --remote --output="$TMP_SQL" )

echo "Loading into SQLite: $OUT_DB"
rm -f "$OUT_DB"
sqlite3 "$OUT_DB" < "$TMP_SQL"
rm -f "$TMP_SQL"

echo "Done. Tables with rows:"
sqlite3 "$OUT_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%';" \
  | while read -r t; do c=$(sqlite3 "$OUT_DB" "SELECT COUNT(*) FROM \"$t\";"); [ "$c" -gt 0 ] && printf "  %-24s %s\n" "$t" "$c"; done
