#!/usr/bin/env bash
# Applies the committed baseline + seed + every migration in order, then runs
# the authorization suite. Uses a scratch database; never touches production.
set -euo pipefail
cd "$(dirname "$0")/.."
PGHOST="${PGHOST:-/tmp}"; PGPORT="${PGPORT:-5433}"; PGUSER="${PGUSER:-postgres}"
DB="${DB:-dafsync_test}"
P=(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -X -v ON_ERROR_STOP=1 -q)
"${P[@]}" -d postgres -c "drop database if exists $DB;" -c "create database $DB;" >/dev/null
"${P[@]}" -d "$DB" -f supabase/baseline/00_current_production_schema.sql >/dev/null 2>&1
"${P[@]}" -d "$DB" -f supabase/baseline/01_seed_representative_data.sql >/dev/null 2>&1
for f in supabase/migrations/*.sql; do
  case "$f" in *.down.sql) continue;; esac
  echo "applying $(basename "$f")"
  "${P[@]}" -d "$DB" -f "$f" >/dev/null 2>&1
done
echo "--- authorization suite ---"
"${P[@]}" -d "$DB" -f supabase/tests/rls_authorization.sql 2>&1 | sed 's/^psql:[^ ]* //' | grep -E "pass:|FAIL|ERROR|ALL AUTH"
