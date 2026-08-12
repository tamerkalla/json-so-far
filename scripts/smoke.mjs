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
import { parsePartial as parsePartialEsm } from '../dist/index.js';

const require = createRequire(import.meta.url);
const { parsePartial: parsePartialCjs } = require('../dist/index.cjs');

// `[1, 2]` is closed by its own `]`, so both elements are final. `"hel` is
// still open, so it comes back as the prefix received so far.
const INPUT = '{"a": [1, 2], "b": "hel';
const EXPECTED = '{"a":[1,2],"b":"hel"}';

let failed = false;
for (const [label, parsePartial] of [
  ['ESM', parsePartialEsm],
  ['CJS', parsePartialCjs],
]) {
  const actual = JSON.stringify(parsePartial(INPUT));
  try {
    assert.equal(actual, EXPECTED);
    console.log(`  ${label} build OK  ${INPUT}  ->  ${actual}`);
  } catch {
    console.error(`  ${label} build FAILED`);
    console.error(`    expected: ${EXPECTED}`);
    console.error(`    actual:   ${actual}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('Both published entry points load and behave.');
