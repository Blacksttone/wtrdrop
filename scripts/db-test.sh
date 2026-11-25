#!/usr/bin/env bash
# Spins up a throwaway PostgreSQL cluster, applies a Supabase shim + all
# migrations, then runs the SQL test suites in supabase/tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$ROOT/.tmp-pg"
PORT="${PGPORT_TEST:-54329}"
export PGHOST=/tmp PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres

RUN_AS=""
cleanup() {
  set +e
  if [ -n "${KEEP_LOG:-}" ] && [ -f "$DATA/server.log" ]; then cat "$DATA/server.log"; fi
  $RUN_AS "$PGBIN/pg_ctl" -D "$DATA" -m fast -w stop >/dev/null 2>&1
  rm -rf "$DATA"
}
trap cleanup EXIT
rm -rf "$DATA"
RUN_AS=""
if [ "$(id -u)" = "0" ]; then
  id waterdrop_pg >/dev/null 2>&1 || useradd -M -r waterdrop_pg
  mkdir -p "$DATA" && chown waterdrop_pg "$DATA"
  RUN_AS="runuser -u waterdrop_pg --"
fi

$RUN_AS "$PGBIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
$RUN_AS "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c timezone=UTC" -l "$DATA/server.log" -w start >/dev/null

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
createdb wd_template
"${PSQL[@]}" -d wd_template -f "$ROOT/supabase/tests/00_supabase_shim.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate  $(basename "$f")"
  "${PSQL[@]}" -d wd_template -f "$f" 2>&1 | grep -v "NOTICE" || true
  [ "${PIPESTATUS[0]}" = "0" ] || { echo "MIGRATION FAILED: $(basename "$f")"; exit 1; }
done
# re-running migrations must not be required, but idempotent seeds should hold
for f in "$ROOT"/supabase/tests/[1-9]*.sql; do
  echo "test     $(basename "$f")"
  db="wd_$(basename "$f" .sql)"
  createdb -T wd_template "$db"
  "${PSQL[@]}" -d "$db" -o /dev/null -f "$ROOT/supabase/tests/01_helpers.sql" -f "$f" 2>&1 | sed -n "s/.*NOTICE:  ok - /  ✓ /p; /ERROR\|FAILED\|CONTEXT/p"
  [ "${PIPESTATUS[0]}" = "0" ] || { echo "FAILED: $(basename "$f")"; exit 1; }
done
echo "All database tests passed."
