#!/usr/bin/env bash
# Bundle and run a Node test: tests/run-node.sh tests/service.test.ts
set -e
SP=${MW_TEST_TMP:-${TMPDIR:-/tmp}/multiwarden-tests}
mkdir -p "$SP"
export MW_TEST_TMP=$SP
out=$SP/$(basename "$1" .ts).cjs
npx esbuild "$1" --bundle --platform=node --format=cjs --outfile="$out" --log-level=warning --define:__TEST__=true --external:playwright-core --external:esbuild
NODE_PATH="$PWD/node_modules" node "$out"
