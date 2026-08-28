# Verifying json-so-far

This reproduces the README's headline claim — a truncated JSON buffer parses to
a truthful prefix of the finished value, and per-field settledness is tracked
separately from what is merely emitted — from the published package, in a
clean directory. It does not require this repository to be checked out.

```bash
mkdir -p json-so-far-verify && cd json-so-far-verify
npm init -y >/dev/null 2>&1
npm install json-so-far@latest >/dev/null 2>&1
cat > verify.mjs <<'JS'
import { parsePartial, parseSettled } from 'json-so-far';

console.log(JSON.stringify(parsePartial('{"title": "The Rise of')));

const r = parseSettled('{"city": "San Jose", "temp": 21');
console.log(
  JSON.stringify(r.value),
  r.isSettled('city'),
  r.isSettled('temp'),
  JSON.stringify(r.settledPaths()),
);
JS
node verify.mjs
```

Expected output:

```text
{"title":"The Rise of"}
{"city":"San Jose"} true false ["/city"]
```

The first line is the README's opening example: `JSON.parse` would throw on
that buffer, but `parsePartial` returns the string built so far, which is
genuinely a prefix of `"The Rise of the Something"` or whatever the stream
finishes with. The second line is [Settled paths](README.md#settled-paths):
`city` closed on its final quote and is safe to act on; `temp`'s `21` has not
seen the delimiter that would prove it isn't still growing into `210`, so it
stays unsettled even though it is already emitted.

## Everything else

```bash
git clone https://github.com/tamerkalla/json-so-far.git && cd json-so-far
npm ci
npm run typecheck
npm test               # the five invariants, property-tested at every
                        # truncation index of every generated document
npm run build
node scripts/smoke.mjs # both published entry points, ESM and CJS
npm run mutation        # Stryker, threshold 85% (currently 88.55%)
```

No network access is required by any of these except the initial install.
