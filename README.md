# json-so-far

**A best-effort parser for JSON that hasn't finished arriving.**

[![build](https://github.com/tamerkalla/json-so-far/actions/workflows/release.yml/badge.svg)](https://github.com/tamerkalla/json-so-far/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/json-so-far.svg)](https://www.npmjs.com/package/json-so-far)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen.svg)](https://www.npmjs.com/package/json-so-far)
[![mutation score](https://img.shields.io/badge/mutation%20score-88.55%25-brightgreen.svg)](#mutation-score-8855)

An LLM streams you this:

```
{"title": "The Rise of
```

`JSON.parse` throws. Your UI has nothing to render. This library returns:

```js
{ title: 'The Rise of' }
```

Call it on the buffer after every chunk. The output only ever grows, so you can
render it straight into your view without ever having to retract something the
user already saw.

```bash
npm install json-so-far
```

Zero dependencies. Zero I/O. ESM + CJS. ~2 kB minified. Node 18+, browsers, workers, edge.

---

## Quick start

```ts
import { parsePartial } from 'json-so-far';

let buffer = '';
for await (const chunk of stream) {
  buffer += chunk;
  render(parsePartial(buffer)); // always safe, never throws
}
```

A React component that renders structured output as it lands:

```tsx
const [buffer, setBuffer] = useState('');
const article = parsePartial<{ title?: string; tags?: string[] }>(buffer);

return (
  <article>
    <h1>{article?.title ?? '…'}</h1>
    {article?.tags?.map((t) => <Tag key={t} name={t} />)}
  </article>
);
```

Salvaging a response that got cut off by a token limit — a different job, one flag:

```ts
parsePartial(truncatedResponse, { streaming: false });
// end-of-input now *terminates* the last token instead of invalidating it
```

---

## What it emits, exactly

This is the part where partial-JSON libraries quietly disagree with each other,
so here is the whole table. Every row is covered by a test; changing one is a
breaking change.

| Input so far | Result | Why |
| --- | --- | --- |
| `{` | `{}` | |
| `{"na` | `{}` | A half-arrived key names nothing |
| `{"name"` | `{}` | Key known, but no value has started |
| `{"name":` | `{}` | Same — we will not invent a value |
| `{"name": "` | `{ name: '' }` | The string has begun |
| `{"name": "Al` | `{ name: 'Al' }` | A prefix is truthful |
| `{"name": "Al",` | `{ name: 'Al' }` | |
| `["a", "b` | `['a', 'b']` | |
| `[1, 2` | `[1]` | **`2` may still be growing into `25`** |
| `[1, 2]` | `[1, 2]` | The `]` proves `2` finished |
| `[tru` | `[true]` | Nothing but `true` starts with `tru` |
| `[nul` | `[null]` | Same reasoning |
| `[tx` | `[]` | Already invalid — not partial, just wrong |
| `["ab\` | `['ab']` | A dangling escape is dropped, not emitted |
| `["ab\u00` | `['ab']` | The code point is not knowable yet |
| `["\uD83D` | `['\uD83D']` | Lone surrogate; its partner joins next chunk |
| `not json` | `undefined` | |

### Why numbers are withheld by default

Strings and numbers are not symmetrical, and treating them the same is the most
common way to get this wrong.

A truncated string is a **prefix** of the final string — `"Al"` is genuinely the
beginning of `"Alice"`, and showing it to a user is honest.

A truncated number is a **different number**. `12` is a prefix of the *text*
`125`, but it is not an approximation of it. Worse, `0.5` truncated to `0`
inverts its meaning, and `-1` truncated to `-` is nothing at all. So by default
a number is emitted only once a delimiter (`,`, `}`, `]`, whitespace) proves it
finished.

If a jittery number beats a missing one for your UI, opt in:

```ts
parsePartial('{"progress": 0.85', { partialNumbers: true }); // { progress: 0.8 }
```

---

## API

### `parsePartial<T>(text, options?): T | undefined`

Returns the value recovered so far, or `undefined` if nothing is determinable
yet. **Never throws, for any input.** Non-string input returns `undefined`.

### `parsePartialResult<T>(text, options?): { value, complete }`

Same, plus whether the value was closed off by its own syntax:

```ts
parsePartialResult('{"a": 1}'); // { value: { a: 1 }, complete: true }
parsePartialResult('{"a": 1');  // { value: {},       complete: false }
```

`complete: false` means "keep feeding me" — not "your input was malformed".

### Options

| Option | Default | Effect |
| --- | --- | --- |
| `partialStrings` | `true` | Emit the characters of a string that have arrived |
| `partialNumbers` | `false` | Emit the longest complete numeric prefix ([why](#why-numbers-are-withheld-by-default)) |
| `streaming` | `true` | Whether more input may still arrive. `false` treats end-of-input as the end of the last token — the "salvage a truncated response" mode |

---

## Settled paths

`complete` tells you the *document* finished. It cannot tell you which *fields*
finished — and that is what decides whether you may act on one.

```
{"city": "San Jose", "temp": 21
```

`city` is final: its closing quote arrived. `temp` is not: `21` may still become
`210`. Both render. Only one is safe to commit, dispatch, or mark done.

```ts
import { parseSettled } from 'json-so-far';

const r = parseSettled('{"city": "San Jose", "temp": 21');

r.value;             // { city: 'San Jose' }
r.isSettled('city'); // true
r.isSettled('temp'); // false — and false for any path not present
r.settledPaths();    // ['/city']   RFC 6901 pointers, '' is the root
r.isSettled();       // false — the root, always equal to r.complete
```

A path settles when its own syntax closes it: a string on its closing quote, a
number on the delimiter after it, containers on their bracket, `true`/`false`/
`null` when fully consumed. Being *emitted* and being *settled* are independent —
`partialNumbers` moves the first and never the second.

**This is the thing neither [`partial-json-parser`](https://www.npmjs.com/package/partial-json-parser)
nor [`json-repair`](https://pypi.org/project/json-repair/) does.** They recover a
value from incomplete JSON; neither reports per-field finality, so every field
you get back is one you still cannot trust.

Settledness is permanent, with one exception: a duplicate key rebinds an
already-settled path, since last-wins matches `JSON.parse`. Detecting it would
mean withholding every key until its object closed.

## How this is tested

The claim is *reliable*, not *fast*, so the tests are the product. Correctness
here is a property, not a list of examples: **for every valid JSON document, at
every truncation index, five invariants hold.** A 30-character document is 31
assertions; a few hundred generated documents is tens of thousands of cases,
from about twenty lines of [fast-check](https://fast-check.dev).

| # | Invariant |
| --- | --- |
| 1 | **Never throws** — any string, any truncation, any option combination |
| 2 | **Output is a truthful prefix** of the completed value. Arrays are never too long, object keys are the first keys in order, strings are character prefixes, numbers are exact |
| 3 | **The last index reproduces `JSON.parse` exactly** |
| 4 | **Output only ever grows** — index `i`'s result is always a prefix of index `i+1`'s. This is what makes rendering it directly safe |
| 5 | **Chunk boundaries are irrelevant** — the same bytes in 1-byte or 7-byte chunks give the same answer |

Plus: no generated document can pollute `Object.prototype` (see below).

### Mutation score: 88.55%

Line coverage tells you a line *ran*. It does not tell you a test would have
**noticed** if that line were wrong. [Stryker](https://stryker-mutator.io)
answers the second question by deliberately corrupting the source — flipping
`<` to `<=`, deleting statements, negating conditions — and checking that the
suite fails each time.

**464 of 524 mutants detected.** Run it yourself:

```bash
npm run mutation
```

CI fails the build below 85% and uploads the full HTML report as an artifact on
every run.

See [VERIFY.md](VERIFY.md) to reproduce the headline claim from the published
package, in a clean directory.

The mutation run uses fewer fast-check iterations than the normal test job
(`FC_RUNS_SCALE`), because Stryker re-runs the covering tests once per mutant
and full strength turned a four-minute job into half an hour. This costs
nothing measurable: the scaled run kills *exactly* the same mutants — 450
killed, 14 timed out, 60 survived, byte for byte the same score. Mutation
testing asks whether a test fails, not how many random cases it tried, and each
case here already sweeps every truncation index of an entire document.

#### What the surviving 60 are

Publishing a score without saying what it missed is most of the way back to a
coverage badge, so: the first run scored **78.01%**, and reading the survivors
found two genuinely different problems.

About half were real gaps — the `complete` flag was barely asserted anywhere, so
mutations that made it permanently optimistic went unnoticed. That produced the
invariant pinning `complete` at *every* truncation index. Another was a bound in
the `\uXXXX` validator: no test passed a literal `A` as a hex digit, so
`> 'A'` instead of `>= 'A'` survived — a bug that mangles exactly one code
point, `©`, and nothing else.

The rest were **equivalent mutants** — changes that cannot alter behaviour, so no
test can ever kill them. Most come from one pattern: `src[p]` is `undefined` past
the end of the string, and every comparison against `undefined` is false, so
`p < n && src[p] === '.'` behaves identically to `p <= n && src[p] === '.'`. The
bounds check is redundant to the *machine* and load-bearing for the *reader*, so
it stays, and those mutants stay alive. Where redundancy was real rather than
explanatory — a duplicated escape branch, a dead length check — it was deleted
instead, which is why the mutant count fell from 573 to 524 while the code got
shorter.

That is the honest ceiling here, and it is why the threshold sits at 85 rather
than 100.

### Prototype pollution

`obj['__proto__'] = value` mutates the object's prototype instead of creating a
property. Parsers that build objects by plain assignment inherit that bug. This
one uses `Object.defineProperty` for `__proto__`, which both closes the hole and
matches what `JSON.parse` does:

```ts
parsePartial('{"__proto__": {"polluted": true}}');
({}).polluted; // undefined
```

---

## Performance

`parsePartial` is a single-pass O(n) scan with no allocation beyond the result.
It is designed to be re-run on the whole buffer after each chunk, which makes a
full stream O(n²) in total — for LLM output measured in kilobytes, that is
microseconds and not worth optimizing. If you are streaming megabytes, parse on
a debounce (say every 50 ms) rather than every token.

---

## Releasing

Releasing is a button: run the Release workflow from the Actions tab, pick a
bump, and CI verifies, versions, tags, publishes, and cuts the GitHub Release
itself. No tag ceremony, no release page to fill in, no credential:
publishing authenticates with [npm Trusted
Publishing](https://docs.npmjs.com/trusted-publishers), so there is no token
stored in the repository at all.

---

## License

MIT © [Tamer Kalla](https://github.com/tamerkalla)
