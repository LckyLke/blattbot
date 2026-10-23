#!/usr/bin/env bash
# Start Overleaf Community Edition in Docker for scripts/overleaf-ce-verify.ts,
# create a user, log in, and print the two variables the check needs:
#
#   BLATTBOT_CE_URL=http://127.0.0.1:8090
#   BLATTBOT_CE_COOKIE=overleaf.sid=…
#
# In CI, append the output to $GITHUB_ENV. Locally: eval "$(scripts/overleaf-ce-up.sh)".
# Set DOCKER="sudo docker" when your user cannot reach the Docker daemon.
# Remove everything again with: scripts/overleaf-ce-up.sh --down
set -euo pipefail

DOCKER=${DOCKER:-docker}
PORT=${OVERLEAF_CE_PORT:-8090}
IMAGE=${OVERLEAF_CE_IMAGE:-sharelatex/sharelatex:latest}
PREFIX=${OVERLEAF_CE_NAME:-blattbot-ce}
URL="http://127.0.0.1:$PORT"

if [ "${1:-}" = "--down" ]; then
  $DOCKER rm -f "$PREFIX" "$PREFIX-mongo" "$PREFIX-redis" >/dev/null 2>&1 || true
  $DOCKER network rm "$PREFIX" >/dev/null 2>&1 || true
  exit 0
fi

EMAIL=ci@example.com
# Overleaf refuses passwords that contain the email address or its local part.
PASSWORD="Verify-$(openssl rand -hex 10)-Pass"

$DOCKER network create "$PREFIX" >/dev/null 2>&1 || true
$DOCKER run -d --name "$PREFIX-mongo" --network "$PREFIX" mongo:8.0 --replSet overleaf >/dev/null
$DOCKER run -d --name "$PREFIX-redis" --network "$PREFIX" redis:7 >/dev/null
for _ in $(seq 1 60); do
  $DOCKER exec "$PREFIX-mongo" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1 && break
  sleep 2
done
$DOCKER exec "$PREFIX-mongo" mongosh --quiet \
  --eval "rs.initiate({ _id: 'overleaf', members: [{ _id: 0, host: '$PREFIX-mongo:27017' }] })" >/dev/null

$DOCKER run -d --name "$PREFIX" --network "$PREFIX" -p "127.0.0.1:$PORT:80" \
  -e OVERLEAF_MONGO_URL="mongodb://$PREFIX-mongo/sharelatex" \
  -e OVERLEAF_REDIS_HOST="$PREFIX-redis" -e REDIS_HOST="$PREFIX-redis" \
  -e OVERLEAF_SITE_URL="$URL" \
  -e EMAIL_CONFIRMATION_DISABLED=true \
  -e OVERLEAF_INVITE_TOKEN_SECRET="$(openssl rand -base64 32)" \
  "$IMAGE" >/dev/null

ready=""
for _ in $(seq 1 120); do
  if [ "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$URL/login")" = "200" ]; then ready=1; break; fi
  sleep 3
done
[ -n "$ready" ] || { echo "Overleaf did not start; see: $DOCKER logs $PREFIX" >&2; exit 1; }

# The admin script prints the activation link on its own indented line (the
# JSON mail log before it holds an HTML-escaped copy); set the password with it.
ACTIVATE=$($DOCKER exec "$PREFIX" bash -c \
  "cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user.mjs --admin --email=$EMAIL" \
  | grep -E '^[[:space:]]+http[^ ]*/user/activate' | tail -1 | tr -d '[:space:]')
[ -n "$ACTIVATE" ] || { echo "could not create the test user" >&2; exit 1; }
ACTIVATE="${ACTIVATE/http:\/\/127.0.0.1:$PORT/$URL}"
TOKEN=$(echo "$ACTIVATE" | sed -E 's/.*token=([0-9a-f]+).*/\1/')

JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT
csrf() {
  curl -s --noproxy '*' -c "$JAR" -b "$JAR" "$1" \
    | grep -oE 'name="ol-csrfToken" content="[^"]+"' | sed -E 's/.*content="([^"]+)"/\1/'
}
post() {
  curl -s --noproxy '*' -c "$JAR" -b "$JAR" -o /dev/null -w '%{http_code}' \
    -H 'Content-Type: application/json' -H "X-Csrf-Token: $2" -d "$3" "$URL$1"
}
code=$(post /user/password/set "$(csrf "$ACTIVATE")" \
  "{\"passwordResetToken\":\"$TOKEN\",\"password\":\"$PASSWORD\",\"email\":\"$EMAIL\"}")
[ "$code" = "200" ] || [ "$code" = "302" ] || { echo "setting the password failed: HTTP $code" >&2; exit 1; }
: >"$JAR"
code=$(post /login "$(csrf "$URL/login")" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
SID=$(awk '$6 == "overleaf.sid" { print $7 }' "$JAR")
[ -n "$SID" ] || { echo "login failed: HTTP $code" >&2; exit 1; }

echo "BLATTBOT_CE_URL=$URL"
echo "BLATTBOT_CE_COOKIE=overleaf.sid=$SID"
