#!/usr/bin/env bash
# Runs the complete test suite (Node + browser). Expects tests/serve.mjs on :9000 and the TLS proxy
# (tests/tls-proxy.mjs 8443 8001 …) for the CLI cross-check.
set -e
SP=${MW_TEST_TMP:-${TMPDIR:-/tmp}/multiwarden-tests}
mkdir -p "$SP"
export MW_TEST_TMP=$SP
reset() { ./tests/reset-servers.sh > "$SP/reset.log" 2>&1; }
run() { echo "== $1"; ./tests/run-node.sh "$1" | grep -E "FAIL|ALL PASSED|FAILED|Error" ; }
npm run -s build:test
run tests/crypto.test.ts
run tests/policies.test.ts
reset; run tests/service.test.ts
reset; run tests/twofactor.test.ts
reset; run tests/features.test.ts
reset; run tests/tools.test.ts
run tests/compat.test.ts
reset; run tests/sso.test.ts
run tests/tde.test.ts
run tests/e2e-passkey.ts
reset; echo "== e2e"; node tests/e2e.mjs | grep -E "FAIL|PASSED"
reset; echo "== e2e-autofill"; node tests/e2e-autofill.mjs | grep -E "FAIL|PASSED"
echo "== e2e-fill"; node tests/e2e-fill.mjs | grep -E "FAIL|PASSED"
echo "== e2e-ui"; node tests/e2e-ui.mjs | grep -E "FAIL|PASSED"
reset; echo "== e2e-toolbox"; node tests/e2e-toolbox.mjs | grep -E "FAIL|PASSED"
echo "== e2e-items"; node tests/e2e-items.mjs | grep -E "FAIL|PASSED"
echo "== e2e-tools"; node tests/e2e-tools.mjs | grep -E "FAIL|PASSED"
reset; echo "== e2e-account"; node tests/e2e-account.mjs | grep -E "FAIL|PASSED"
reset; echo "== e2e-org"; node tests/e2e-org.mjs | grep -E "FAIL|PASSED"
reset; echo "== e2e-live"; node tests/e2e-live.mjs | grep -E "FAIL|PASSED"
reset
npx esbuild tests/webauthn-setup.ts --bundle --platform=node --format=cjs --outfile="$SP/wa.cjs" --log-level=warning --define:__TEST__=true
node "$SP/wa.cjs" "$SP/webauthn-cred.json"
echo "== e2e-features"; node tests/e2e-features.mjs | grep -E "FAIL|PASSED"
