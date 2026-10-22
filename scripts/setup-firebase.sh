#!/usr/bin/env bash
# One-time Firebase setup for DocuMind AI (project: documind-ai-c8e09). No login/auth providers needed.
# Registers a Web app, writes .env, creates Firestore if missing, deploys locked-down rules + indexes.
set -euo pipefail
PROJECT="documind-ai-c8e09"
FB="npx -y firebase-tools@latest"
cd "$(dirname "$0")/.."

if ! $FB login:list 2>&1 | grep -qiE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'; then $FB login; fi

APP_ID=$($FB apps:list WEB --project "$PROJECT" 2>&1 | grep -oE '1:[0-9]+:web:[0-9a-f]+' | head -1 || true)
if [ -z "$APP_ID" ]; then
  APP_ID=$($FB apps:create web "DocuMind AI" --project "$PROJECT" 2>&1 | tee /dev/stderr | grep -oE '1:[0-9]+:web:[0-9a-f]+' | head -1)
fi
echo "Web App ID: $APP_ID"

CFG=$($FB apps:sdkconfig WEB "$APP_ID" --project "$PROJECT" 2>/dev/null)
get() { printf '%s' "$CFG" | grep -oE "\"?$1\"?[[:space:]]*:[[:space:]]*\"[^\"]+\"" | head -1 | sed -E 's/.*:[[:space:]]*"([^"]+)"/\1/'; }
cat > .env <<ENV
VITE_FIREBASE_API_KEY=$(get apiKey)
VITE_FIREBASE_AUTH_DOMAIN=$(get authDomain)
VITE_FIREBASE_PROJECT_ID=$(get projectId)
VITE_FIREBASE_STORAGE_BUCKET=$(get storageBucket)
VITE_FIREBASE_APP_ID=$(get appId)
ENV

# Standard edition: the app uses Firestore vector search
if ! $FB firestore:databases:list --project "$PROJECT" 2>&1 | grep -q '(default)'; then
  $FB firestore:databases:create "(default)" --edition=standard --location="${FIRESTORE_LOCATION:-asia-south1}" --project "$PROJECT"
fi
$FB deploy --only firestore:rules,firestore:indexes --project "$PROJECT"
echo "Next: enable Storage in the Console (Build > Storage), set the Gemini secret, deploy storage+functions+hosting (see README)."
