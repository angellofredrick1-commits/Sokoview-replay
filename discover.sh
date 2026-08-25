#!/usr/bin/env bash
# Finds the real prices endpoint on your Sokoview staging API.
#
#   export SOKOVIEW_API_KEY='skv_...'      # your NEW key, after rotating
#   ./discover.sh
#
# Nothing is written anywhere. Paste the output back (it prints no key).

BASE="${SOKOVIEW_API_BASE:-https://api-staging.sokoview.co.tz}"
KEY="${SOKOVIEW_API_KEY:?set SOKOVIEW_API_KEY first}"
SYM="${1:-CRDB}"

echo "== base: $BASE =="
echo

# 1. Self-documenting routes, if the framework exposes any.
echo "--- spec / docs routes ---"
for p in /openapi.json /swagger.json /docs /api-docs /api/docs /redoc /routes /api; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$BASE$p")
  [ "$code" != "404" ] && echo "  $code  $p"
done
echo

# 2. Common shapes for a price-history route.
echo "--- price history routes (auth: Bearer) ---"
for p in \
  "/api/v1/prices?symbol=$SYM" \
  "/api/v1/stocks/$SYM/prices" \
  "/api/v1/stocks/$SYM/history" \
  "/api/v1/securities/$SYM/prices" \
  "/api/v1/equities/$SYM/history" \
  "/api/prices?symbol=$SYM" \
  "/v1/prices?symbol=$SYM" \
  "/prices?symbol=$SYM" \
  "/api/v1/stocks" \
  "/api/v1/securities" ; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 \
         -H "Authorization: Bearer $KEY" -H 'Accept: application/json' "$BASE$p")
  [ "$code" != "404" ] && echo "  $code  $p"
done
echo

# 3. If Bearer gives 401 everywhere, the auth style may differ.
echo "--- auth style check on /api/v1/stocks ---"
for h in "Authorization: Bearer $KEY" "X-API-Key: $KEY" "Api-Key: $KEY" "Authorization: Token $KEY"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 -H "$h" "$BASE/api/v1/stocks")
  echo "  $code  ${h%%:*}"
done
echo

echo "--- now dump the body of whichever path returned 200 ---"
echo "  curl -s -H \"Authorization: Bearer \$SOKOVIEW_API_KEY\" \\"
echo "       \"$BASE/THE_WORKING_PATH\" | head -c 1200"
