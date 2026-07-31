#!/usr/bin/env bash
#
# Build a puzzle bank end to end: logs -> decisions -> candidates -> ukeire
# annotation -> akochan verification -> sharded JSON.
#
#   ./scripts/run-pipeline.sh [games] [stride]
#
# Defaults produce roughly 800 puzzles in about 15 minutes on an M5.
#
# Prerequisites:
#   - A trained checkpoint at pipeline/data/model.pt (see pipeline/train.py).
#   - An akochan build (./scripts/build-akochan.sh).
#   - Logs under pipeline/data/2010 (see pipeline/TODO.md for the dataset).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Credentials for the upload step. Sourcing this is what makes step 6 run at
# all: without it the script checked an environment variable it had never loaded
# and silently skipped the upload, leaving the site on the previous bank.
if [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
fi

GAMES="${1:-1200}"
STRIDE="${2:-200}"

# Games 0-13,999 trained the model and 14,000-15,999 were its holdout. Mining
# starts past both so no puzzle comes from a position the model was fitted on.
SKIP=16000

LOGS="pipeline/data/2010"
WORK="pipeline/data/mining"
CHECKPOINT="pipeline/data/model.pt"
AKOCHAN="vendor/akochan/system.exe"

# torch lives in the system python's user site-packages, not in Homebrew's
# python3 — which is what `python3` resolves to and which fails at import. Being
# explicit here beats a confusing ModelNotAvailable further down.
PYTHON="${PYTHON:-/usr/bin/python3}"
if ! "$PYTHON" -c "import torch" 2>/dev/null; then
  echo "no torch in $PYTHON; set PYTHON= to an interpreter that has it" >&2
  exit 1
fi
if [ ! -x "$AKOCHAN" ]; then
  echo "no akochan binary; run ./scripts/build-akochan.sh" >&2
  exit 1
fi

mkdir -p "$WORK"

echo "==> 1/5 extract ($GAMES games from offset $SKIP)"
"$PYTHON" -m pipeline.extract \
  --input "$LOGS" --output "$WORK/decisions.jsonl.gz" \
  --skip "$SKIP" --limit "$GAMES" --skip-errors

echo "==> 2/5 mine (every ${STRIDE}th decision)"
"$PYTHON" -m pipeline.mine \
  --input "$WORK/decisions.jsonl.gz" --output "$WORK/candidates.jsonl" \
  --checkpoint "$CHECKPOINT" --stride "$STRIDE"

echo "==> 3/5 annotate with the ukeire baseline"
npm run --silent annotate:ukeire -- \
  --input "$WORK/candidates.jsonl" --output "$WORK/annotated.jsonl"

echo "==> 4/5 verify with akochan"
"$PYTHON" -m pipeline.verify \
  --input "$WORK/annotated.jsonl" --output "$WORK/verified.jsonl" \
  --logs "$LOGS" --akochan "$AKOCHAN" \
  --reject-log "$WORK/rejects.jsonl" --progress-every 250

echo "==> 5/5 export"
"$PYTHON" -m pipeline.export \
  --input "$WORK/verified.jsonl" --output public/puzzles \
  --generated-at "$(date +%Y-%m-%d)"

# The site reads the database when VITE_PUZZLE_SOURCE=supabase, so regenerating
# the JSON without uploading leaves it serving the previous bank. That is not a
# visible failure — the site works, it just shows puzzles that no longer exist —
# so the upload belongs in the pipeline rather than in someone's memory.
if [ -n "${SUPABASE_SECRET_KEY:-}" ] && [ -f .env.local ]; then
  echo "==> 6/6 upload to Supabase"
  node --env-file=.env.local scripts/upload-bank.mjs
else
  echo
  echo "note: no SUPABASE_SECRET_KEY, so the database was not updated."
  echo "      If the site reads from Supabase it is still serving the old bank."
fi

echo
echo "bank written to public/puzzles. Audit it before shipping:"
echo "  npm test         # includes bank integrity audits"
echo "  npm run typecheck"
