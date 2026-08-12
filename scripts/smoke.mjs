/**
 * Post-build smoke test: proves both published entry points actually load and
 * behave, which `vitest` cannot tell us because it runs against `src/`.
 *
 * Kept as a file rather than an inline `node -e` in the workflow: the payload
 * is JSON full of quotes, and nesting it inside YAML inside a shell string is
 * how you get a test that fails for reasons unrelated to the code.
 *
 * Run with: node scripts/smoke.mjs   (after npm run build)
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '../dist/index.js';

const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs');

// `[1, 2]` is closed by its own `]`, so both elements are final. `"hel` is
// still open, so it comes back as the prefix received so far — and is the one
// path that has not settled.
const INPUT = '{"a": [1, 2], "b": "hel';
const EXPECTED_VALUE = '{"a":[1,2],"b":"hel"}';
const EXPECTED_SETTLED = '["/a","/a/0","/a/1"]';

let failed = false;

function check(label, what, actual, expected) {
  try {
    assert.equal(actual, expected);
    console.log(`  ${label} ${what} OK  ->  ${actual}`);
  } catch {
    console.error(`  ${label} ${what} FAILED`);
    console.error(`    expected: ${expected}`);
    console.error(`    actual:   ${actual}`);
    failed = true;
  }
}

for (const [label, mod] of [
  ['ESM', esm],
  ['CJS', cjs],
]) {
  for (const name of ['parsePartial', 'parsePartialResult', 'parseSettled']) {
    if (typeof mod[name] !== 'function') {
      console.error(`  ${label} does not export ${name}`);
      failed = true;
    }
  }
  if (failed) continue;

  check(label, 'parsePartial      ', JSON.stringify(mod.parsePartial(INPUT)), EXPECTED_VALUE);

  const settled = mod.parseSettled(INPUT);
  check(label, 'parseSettled value', JSON.stringify(settled.value), EXPECTED_VALUE);
  check(label, 'settledPaths      ', JSON.stringify(settled.settledPaths()), EXPECTED_SETTLED);
  check(label, 'isSettled(a)      ', String(settled.isSettled('a')), 'true');
  check(label, 'isSettled(b)      ', String(settled.isSettled('b')), 'false');
  check(label, 'isSettled()==done ', String(settled.isSettled() === settled.complete), 'true');
}

if (failed) process.exit(1);
console.log('Both published entry points load and behave.');
