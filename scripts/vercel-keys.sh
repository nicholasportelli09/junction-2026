#!/bin/sh
# Copies the model, search and voice settings from this checkout's local settings file to the linked Vercel
# project (production), then deploys. Run it yourself, from anywhere:
#
#   sh scripts/vercel-keys.sh            copy the settings and deploy
#   DRY_RUN=1 sh scripts/vercel-keys.sh  only list the names that would be copied
#
# Values are piped straight to Vercel and never printed. Only names starting with MODEL_, NEMOTRON_, VERDA_,
# GEMINI_, EXA_, CONTEXT_DEV_ or ELEVENLABS_ are copied. VERDA_BASE_URL is left alone on purpose: on the laptop
# it is the SSH tunnel, which a hosted server cannot use (see deploy/verda/public-https.sh).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
FILE="${SETTINGS_FILE:-$ROOT/.env.local}"
[ -f "$FILE" ] || { echo "No settings file at $FILE." >&2; exit 1; }
[ -f "$ROOT/.vercel/project.json" ] || { echo "This checkout is not linked to a Vercel project. Run: vercel link" >&2; exit 1; }

COPIED=0
FAILED=0
NAMES=$(grep -E '^(MODEL_|NEMOTRON_|VERDA_|GEMINI_|EXA_|CONTEXT_DEV_|ELEVENLABS_)[A-Z0-9_]*=' "$FILE" | cut -d= -f1 | sort -u)
for NAME in $NAMES; do
  [ "$NAME" = "VERDA_BASE_URL" ] && continue
  # The last line that sets the name wins, as it does when the app reads the file.
  VALUE=$(grep -E "^$NAME=" "$FILE" | tail -1 | cut -d= -f2-)
  case "$VALUE" in
    \"*\") VALUE=${VALUE#\"}; VALUE=${VALUE%\"} ;;
    \'*\') VALUE=${VALUE#\'}; VALUE=${VALUE%\'} ;;
  esac
  [ -n "$VALUE" ] || continue
  if [ "${DRY_RUN:-}" = "1" ]; then
    echo "  would copy $NAME"
    COPIED=$((COPIED + 1))
    continue
  fi
  case "$NAME" in *KEY*) KIND="--sensitive" ;; *) KIND="--no-sensitive" ;; esac
  if printf '%s' "$VALUE" | vercel env add "$NAME" production --force $KIND >/dev/null 2>&1; then
    echo "  copied $NAME"
    COPIED=$((COPIED + 1))
  else
    echo "  FAILED $NAME" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo "$COPIED settings, $FAILED failed."
[ "${DRY_RUN:-}" = "1" ] && exit 0
[ "$FAILED" -eq 0 ] || { echo "Not deploying, because some settings failed. Is the Vercel command line logged in (vercel whoami)?" >&2; exit 1; }
echo "Deploying..."
vercel deploy --prod --yes 2>&1 | grep -E 'Production URL|https://[a-z0-9.-]+vercel\.app' | tail -2
echo "Done. Check: https://sisu-api.vercel.app/dev/ready"
