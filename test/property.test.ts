import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePartial, parsePartialResult } from '../src/index.js';

/**
 * The correctness argument for this library is not "here are some examples I
 * thought of". It is four invariants, checked against every truncation index of
 * thousands of generated documents.
 *
 * For a document of length L that is 30 characters long, one generated value
 * yields 31 assertions. A few hundred runs is tens of thousands of cases.
 */

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
      { numRuns: 250 },
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
      { numRuns: 2000 },
    );
  });

  it('for arbitrary truncations of arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.nat(), (text, cut) => {
        parsePartial(text.slice(0, cut % (text.length + 1)));
        return true;
      }),
      { numRuns: 2000 },
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
      { numRuns: 300 },
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
      { numRuns: 250 },
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
      { numRuns: 500 },
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
      { numRuns: 500 },
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
      { numRuns: 400 },
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
      { numRuns: 300 },
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
      { numRuns: 300 },
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
      { numRuns: 300 },
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
      { numRuns: 300 },
    );
  });
});
