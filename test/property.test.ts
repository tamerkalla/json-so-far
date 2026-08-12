import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePartial, parsePartialResult, parseSettled } from '../src/index.js';

/**
 * The correctness argument for this library is not "here are some examples I
 * thought of". It is four invariants, checked against every truncation index of
 * thousands of generated documents.
 *
 * For a document of length L that is 30 characters long, one generated value
 * yields 31 assertions. A few hundred runs is tens of thousands of cases.
 */

/**
 * Property-test iteration counts, scaled by `FC_RUNS_SCALE`.
 *
 * At full strength (the default, and what CI's `test` job runs) these numbers
 * are deliberately generous. Under mutation testing they are not affordable:
 * Stryker re-runs the covering tests once per mutant, so a suite that takes two
 * seconds becomes half an hour across 524 mutants.
 *
 * Scaling down costs less than it looks like. Mutation testing asks whether a
 * test *fails*, not how many random cases it tried, and each fast-check case
 * here already sweeps every truncation index of a whole document — so one case
 * is dozens of assertions. The floor keeps any property from degenerating into
 * a handful of samples.
 */
const RUNS_SCALE = Number(process.env.FC_RUNS_SCALE ?? '1');
const runs = (full: number): number => Math.max(10, Math.round(full * RUNS_SCALE));

/**
 * Object keys are prefixed so they can never look like array indices.
 *
 * This is not tidiness: JS reorders integer-like keys, so `JSON.parse('{"2":1,
 * "1":2}')` yields keys in the order `1, 2`. That would make the key-order half
 * of prefix-consistency untestable for reasons that have nothing to do with
 * this parser. `jsonValue` below still exercises unrestricted keys for the
 * invariants that do not depend on ordering.
 */
const safeKey = fc.string({ minLength: 0, maxLength: 6 }).map((s) => `k${s}`);

const orderedJson = fc.letrec<{
  value: unknown;
  array: unknown[];
  object: Record<string, unknown>;
}>((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string(),
    fc.string({ unit: 'binary' }),
    tie('array'),
    tie('object'),
  ),
  array: fc.array(tie('value'), { maxLength: 5 }),
  object: fc.dictionary(safeKey, tie('value'), { maxKeys: 5 }),
})).value;

/**
 * Is `partial` a truthful prefix of `full`?
 *
 * - `undefined` is a prefix of anything (we have not committed to a value).
 * - A string may be a character prefix of the final string.
 * - Everything else must match exactly — in particular numbers, which under the
 *   default options are all-or-nothing.
 * - An array may be short, and only its last element may itself be partial.
 * - An object may be missing trailing keys, but the keys it has must be the
 *   first keys of the full object, in order.
 */
function isPrefixOf(partial: unknown, full: unknown): boolean {
  if (partial === undefined) return true;

  if (typeof full === 'string') {
    return typeof partial === 'string' && full.startsWith(partial);
  }
  if (full === null || typeof full === 'boolean' || typeof full === 'number') {
    return Object.is(partial, full);
  }
  if (Array.isArray(full)) {
    if (!Array.isArray(partial)) return false;
    if (partial.length > full.length) return false;
    return partial.every((element, index) => isPrefixOf(element, full[index]));
  }
  if (typeof full === 'object') {
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
      return false;
    }
    const fullKeys = Object.keys(full as object);
    const partialKeys = Object.keys(partial as object);
    if (partialKeys.length > fullKeys.length) return false;
    for (let i = 0; i < partialKeys.length; i++) {
      if (partialKeys[i] !== fullKeys[i]) return false;
    }
    return partialKeys.every((key) =>
      isPrefixOf(
        (partial as Record<string, unknown>)[key],
        (full as Record<string, unknown>)[key],
      ),
    );
  }
  return false;
}

const OPTION_MATRIX = [
  {},
  { partialStrings: false },
  { partialNumbers: true },
  { partialStrings: false, partialNumbers: true },
  { streaming: false },
] as const;

describe('invariant 1 — never throws', () => {
  it('for every truncation of any JSON document, under every option set', () => {
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        for (let i = 0; i <= text.length; i++) {
          const slice = text.slice(0, i);
          for (const options of OPTION_MATRIX) {
            parsePartial(slice, options);
            parsePartialResult(slice, options);
          }
        }
        return true;
      }),
      { numRuns: runs(250) },
    );
  });

  it('for completely arbitrary strings, JSON or not', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        for (const options of OPTION_MATRIX) {
          parsePartial(text, options);
        }
        return true;
      }),
      { numRuns: runs(2000) },
    );
  });

  it('for arbitrary truncations of arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), (text, cut) => {
        parsePartial(text.slice(0, cut % (text.length + 1)));
        return true;
      }),
      { numRuns: runs(2000) },
    );
  });

  it('does not blow the stack on deeply nested input', () => {
    // Depth is bounded by the runtime's call stack; this documents where.
    expect(() => parsePartial('['.repeat(1000))).not.toThrow();
    expect(() => parsePartial('{"a":'.repeat(500))).not.toThrow();
  });
});

describe('invariant 2 — output is always a truthful prefix', () => {
  it('every truncation yields a prefix of the completed value', () => {
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        const full = JSON.parse(text);
        for (let i = 0; i <= text.length; i++) {
          const partial = parsePartial(text.slice(0, i));
          if (!isPrefixOf(partial, full)) return false;
        }
        return true;
      }),
      { numRuns: runs(300) },
    );
  });

  it('holds with partialStrings disabled too', () => {
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        const full = JSON.parse(text);
        for (let i = 0; i <= text.length; i++) {
          const partial = parsePartial(text.slice(0, i), { partialStrings: false });
          if (!isPrefixOf(partial, full)) return false;
        }
        return true;
      }),
      { numRuns: runs(250) },
    );
  });
});

describe('invariant 3 — the last index reproduces JSON.parse exactly', () => {
  it('for any document, with streaming disabled', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = JSON.stringify(value);
        expect(parsePartial(text, { streaming: false })).toEqual(JSON.parse(text));
        return true;
      }),
      { numRuns: runs(500) },
    );
  });

  it('for object- and array-rooted documents, with default options', () => {
    // A bare trailing scalar is genuinely unknowable mid-stream, which is what
    // `streaming: false` above exists to resolve. Anything with a closing
    // bracket needs no such help.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(fc.jsonValue(), { maxLength: 6 }),
          fc.dictionary(safeKey, fc.jsonValue(), { maxKeys: 6 }),
        ),
        (value) => {
          const text = JSON.stringify(value);
          expect(parsePartial(text)).toEqual(JSON.parse(text));
          expect(parsePartialResult(text).complete).toBe(true);
          return true;
        },
      ),
      { numRuns: runs(500) },
    );
  });
});

describe('invariant 3b — `complete` is exact, never merely optimistic', () => {
  it('is true at the final index and false at every earlier one', () => {
    // For a document rooted in `{` or `[`, the closing bracket is the only
    // thing that can finish it — so completeness is decidable, and this pins it
    // down at every single index rather than spot-checking a few.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.array(fc.jsonValue(), { maxLength: 5 }),
          fc.dictionary(safeKey, fc.jsonValue(), { maxKeys: 5 }),
        ),
        (value) => {
          const text = JSON.stringify(value);
          for (let i = 0; i < text.length; i++) {
            if (parsePartialResult(text.slice(0, i)).complete) return false;
          }
          return parsePartialResult(text).complete;
        },
      ),
      { numRuns: runs(400) },
    );
  });

  it('holds under every option set', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 5 }),
        fc.constantFrom(...OPTION_MATRIX),
        (value, options) => {
          const text = JSON.stringify(value);
          for (let i = 0; i < text.length; i++) {
            if (parsePartialResult(text.slice(0, i), options).complete) return false;
          }
          return parsePartialResult(text, options).complete;
        },
      ),
      { numRuns: runs(300) },
    );
  });
});

describe('invariant 4 — output only ever grows', () => {
  it('a longer prefix of the input yields a prefix-compatible superset', () => {
    // This is what makes it safe to render the result directly: a UI built from
    // it never has to retract something it already showed.
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        for (let i = 0; i < text.length; i++) {
          const earlier = parsePartial(text.slice(0, i));
          const later = parsePartial(text.slice(0, i + 1));
          if (!isPrefixOf(earlier, later)) return false;
        }
        return true;
      }),
      { numRuns: runs(300) },
    );
  });
});

describe('invariant 5 — chunk boundaries are irrelevant', () => {
  it('feeding the same bytes in different chunk sizes gives the same answer', () => {
    fc.assert(
      fc.property(orderedJson, fc.integer({ min: 1, max: 7 }), (value, size) => {
        const text = JSON.stringify(value);
        let buffer = '';
        let last: unknown;
        for (let i = 0; i < text.length; i += size) {
          buffer += text.slice(i, i + size);
          last = parsePartial(buffer);
        }
        expect(last).toEqual(parsePartial(text));
        return true;
      }),
      { numRuns: runs(300) },
    );
  });
});

describe('prototype safety, generatively', () => {
  it('no generated document can pollute Object.prototype', () => {
    const dangerous = fc.constantFrom(
      '__proto__',
      'constructor',
      'prototype',
      'polluted',
    );
    fc.assert(
      fc.property(
        fc.dictionary(dangerous, fc.jsonValue(), { maxKeys: 4 }),
        (value) => {
          const text = JSON.stringify(value);
          for (let i = 0; i <= text.length; i++) {
            parsePartial(text.slice(0, i));
          }
          return (
            ({} as Record<string, unknown>).polluted === undefined &&
            Object.getPrototypeOf({}) === Object.prototype
          );
        },
      ),
      { numRuns: runs(300) },
    );
  });
});

/**
 * Settledness invariants.
 *
 * Settledness is the claim a caller acts on — commits a field, dispatches a
 * request, marks a step done. A false positive is not a rendering glitch, it is
 * acting on a value that then changes. So it is checked the same way as the
 * parser itself: at every truncation index of generated documents.
 */

/** Resolve an RFC 6901 pointer against a parsed document. */
function getByPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    current = Array.isArray(current)
      ? current[Number(segment)]
      : (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe('invariant 6 — a settled path already holds its final value', () => {
  it('every settled path equals that path in the completed document', () => {
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        const full = JSON.parse(text);
        for (let i = 0; i <= text.length; i++) {
          const result = parseSettled(text.slice(0, i));
          for (const pointer of result.settledPaths()) {
            expect(getByPointer(result.value, pointer)).toEqual(
              getByPointer(full, pointer),
            );
          }
        }
        return true;
      }),
      { numRuns: runs(200) },
    );
  });
});

describe('invariant 7 — settled paths only accumulate', () => {
  it('the settled set at each index is a subset of the next', () => {
    // `JSON.stringify` cannot emit a duplicate key, so the one documented
    // exception — a later duplicate rebinding an already-settled path — cannot
    // arise from generated documents.
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        let previous = new Set<string>();
        for (let i = 0; i <= text.length; i++) {
          const current = new Set(parseSettled(text.slice(0, i)).settledPaths());
          for (const pointer of previous) {
            if (!current.has(pointer)) return false;
          }
          previous = current;
        }
        return true;
      }),
      { numRuns: runs(200) },
    );
  });
});

describe('invariant 8 — the root agrees with `complete`', () => {
  it('isSettled() equals complete at every index, under every option set', () => {
    fc.assert(
      fc.property(
        orderedJson,
        fc.constantFrom(...OPTION_MATRIX),
        (value, options) => {
          const text = JSON.stringify(value);
          for (let i = 0; i <= text.length; i++) {
            const slice = text.slice(0, i);
            const result = parseSettled(slice, options);
            if (result.isSettled() !== result.complete) return false;
            // and `complete` itself must not have drifted from the older API
            if (result.complete !== parsePartialResult(slice, options).complete) {
              return false;
            }
          }
          return true;
        },
      ),
      { numRuns: runs(200) },
    );
  });
});

describe('invariant 9 — a finished document settles completely', () => {
  it('every path in a fully parsed document is settled', () => {
    fc.assert(
      fc.property(
        orderedJson,
        fc.constantFrom({}, { streaming: false } as const),
        (value, options) => {
          const text = JSON.stringify(value);
          const result = parseSettled(text, { ...options, streaming: false });
          const settled = new Set(result.settledPaths());

          const walk = (node: unknown, pointer: string): boolean => {
            if (!settled.has(pointer)) return false;
            if (Array.isArray(node)) {
              return node.every((el, i) => walk(el, `${pointer}/${i}`));
            }
            if (typeof node === 'object' && node !== null) {
              return Object.keys(node).every((k) =>
                walk(
                  (node as Record<string, unknown>)[k],
                  `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`,
                ),
              );
            }
            return true;
          };

          return result.complete && walk(result.value, '');
        },
      ),
      { numRuns: runs(200) },
    );
  });
});

describe('invariant 10 — emitted and settled are independent', () => {
  it('toggling partialNumbers never changes the settled set', () => {
    // partialNumbers decides whether a half-arrived number is *emitted*. The
    // path it would occupy is on the unsettled spine either way, so it can
    // never be settled — and no other path is affected.
    fc.assert(
      fc.property(orderedJson, (value) => {
        const text = JSON.stringify(value);
        for (let i = 0; i <= text.length; i++) {
          const slice = text.slice(0, i);
          expect(parseSettled(slice, { partialNumbers: true }).settledPaths()).toEqual(
            parseSettled(slice, { partialNumbers: false }).settledPaths(),
          );
        }
        return true;
      }),
      { numRuns: runs(200) },
    );
  });
});
