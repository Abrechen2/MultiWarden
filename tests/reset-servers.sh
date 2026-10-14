#!/usr/bin/env bash
# Reset the three local Vaultwarden instances and seed test data.
#   VW_DIR       directory with the vaultwarden binary (data of the instances goes to $VW_DIR/a, b, c)
#   MW_TEST_TMP  scratch directory (default: $TMPDIR/multiwarden-tests)
set -e
VW=${VW_DIR:?"VW_DIR must point to a directory containing the vaultwarden binary"}
SP=${MW_TEST_TMP:-${TMPDIR:-/tmp}/multiwarden-tests}
mkdir -p "$SP"
pkill -x vaultwarden || true
[ -f $SP/oidc.pid ] && kill "$(cat $SP/oidc.pid)" 2>/dev/null || true
sleep 1
rm -rf $VW/a $VW/b $VW/c && mkdir -p $VW/a $VW/b $VW/c
# mock identity provider for SSO (server C)
setsid nohup node tests/oidc-mock.mjs > $SP/oidc.log 2>&1 < /dev/null &
echo $! > $SP/oidc.pid
for x in a:8001 b:8002; do
  n=${x%%:*}; p=${x##*:}
  (cd $VW/$n && DATA_FOLDER=$VW/$n ROCKET_PORT=$p ROCKET_ADDRESS=127.0.0.1 WEB_VAULT_ENABLED=false SIGNUPS_ALLOWED=true DOMAIN=http://localhost:$p ORG_EVENTS_ENABLED=true LOG_LEVEL=warn setsid nohup $VW/vaultwarden > $VW/$n.log 2>&1 < /dev/null &)
done
# server C: SSO via the mock IdP
(cd $VW/c && DATA_FOLDER=$VW/c ROCKET_PORT=8003 ROCKET_ADDRESS=127.0.0.1 WEB_VAULT_ENABLED=false SIGNUPS_ALLOWED=true DOMAIN=http://localhost:8003 LOG_LEVEL=warn \
  SSO_ENABLED=true SSO_AUTHORITY=http://localhost:9100 SSO_CLIENT_ID=vaultwarden SSO_CLIENT_SECRET=geheim SSO_SCOPES="email profile" \
  setsid nohup $VW/vaultwarden > $VW/c.log 2>&1 < /dev/null &)
for i in $(seq 1 30); do curl -sf localhost:8001/alive >/dev/null && curl -sf localhost:8002/alive >/dev/null && curl -sf localhost:8003/alive >/dev/null && break; sleep 0.5; done
npx esbuild tests/seed.ts --bundle --platform=node --format=cjs --outfile=$SP/seed.cjs --log-level=warning
node $SP/seed.cjs
