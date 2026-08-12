import { describe, expect, it } from 'vitest';
import { parsePartial, parsePartialResult, parseSettled } from '../src/index.js';

/**
 * These tables are the specification. Every row is a decision about what to
 * emit for a half-arrived token — the exact set of choices that existing
 * partial-JSON libraries make differently from one another. If a row changes,
 * that is a breaking change, not a bug fix.
 */

describe('objects', () => {
  const cases: Array<[input: string, expected: unknown]> = [
    ['{', {}],
    ['{ ', {}],
    ['{"', {}],
    ['{"a', {}], // a half-arrived key names nothing
    ['{"a"', {}], // key complete, but no colon yet
    ['{"a":', {}], // no value has started
    ['{"a": ', {}],
    ['{"a": "', { a: '' }],
    ['{"a": "x', { a: 'x' }],
    ['{"a": "x"', { a: 'x' }],
    ['{"a": "x",', { a: 'x' }],
    ['{"a": "x", "b', { a: 'x' }],
    ['{"a": "x", "b": "y"}', { a: 'x', b: 'y' }],
    ['{"a": {"b": {"c": "deep', { a: { b: { c: 'deep' } } }],
    ['{"a": true, "b": fal', { a: true, b: false }],
    ['{"a": null}', { a: null }],
    ['{}', {}],
    ['  {"a": 1}  ', { a: 1 }],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(parsePartial(input)).toEqual(expected);
  });

  it('lets the last of a duplicated key win, as JSON.parse does', () => {
    expect(parsePartial('{"a": 1, "a": 2}')).toEqual(JSON.parse('{"a": 1, "a": 2}'));
  });

  it('preserves key insertion order', () => {
    expect(Object.keys(parsePartial('{"z": 1, "a": 2, "m": 3}')!)).toEqual([
      'z',
      'a',
      'm',
    ]);
  });
});

describe('arrays', () => {
  const cases: Array<[input: string, expected: unknown]> = [
    ['[', []],
    ['[]', []],
    ['[ ', []],
    ['["', ['']],
    ['["a', ['a']],
    ['["a"', ['a']],
    ['["a",', ['a']],
    ['["a", ', ['a']],
    ['["a", "b"]', ['a', 'b']],
    ['[[[', [[[]]]],
    ['[{"a": [1, 2', [{ a: [1] }]], // 2 may still be growing into 25
    ['[true, false, nul', [true, false, null]],
    ['[1, 2, 3]', [1, 2, 3]],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(parsePartial(input)).toEqual(expected);
  });
});

describe('strings', () => {
  it('emits characters as they arrive', () => {
    expect(parsePartial('["hello wor')).toEqual(['hello wor']);
  });

  it('decodes the standard escapes', () => {
    expect(parsePartial('"a\\n\\t\\"\\\\\\/\\b\\f\\rb"')).toBe(
      'a\n\t"\\/\b\f\rb',
    );
  });

  it('drops a trailing backslash rather than emitting it', () => {
    // `\` could still become `\n`; emitting a literal backslash would not be a
    // prefix of the decoded string.
    expect(parsePartial('["ab\\')).toEqual(['ab']);
  });

  it('drops an incomplete unicode escape', () => {
    expect(parsePartial('["ab\\u')).toEqual(['ab']);
    expect(parsePartial('["ab\\u00')).toEqual(['ab']);
    expect(parsePartial('["ab\\u0041')).toEqual(['abA']);
  });

  it('joins a surrogate pair split across chunks', () => {
    expect(parsePartial('["\\uD83D')).toEqual(['\uD83D']);
    expect(parsePartial('["\\uD83D\\uDE00')).toEqual(['\uD83D\uDE00']);
    expect(parsePartial('["\\uD83D\\uDE00"]')).toEqual(['😀']);
  });

  it('keeps unknown escapes verbatim instead of failing', () => {
    // Models emit these. Strict JSON would reject; we would rather render.
    expect(parsePartial('["a\\qb"]')).toEqual(['aqb']);
  });

  it('can be told to withhold unfinished strings', () => {
    expect(parsePartial('{"a": "hel', { partialStrings: false })).toEqual({});
    expect(parsePartial('{"a": "hel"', { partialStrings: false })).toEqual({
      a: 'hel',
    });
  });
});

describe('numbers', () => {
  it('withholds a number still being received, by default', () => {
    // 12 might be about to become 125. Emitting it would be a lie, not a prefix.
    expect(parsePartial('{"a": 12')).toEqual({});
    expect(parsePartial('[1, 2')).toEqual([1]);
  });

  it('emits a number once a delimiter proves it finished', () => {
    expect(parsePartial('{"a": 12,')).toEqual({ a: 12 });
    expect(parsePartial('[1, 2]')).toEqual([1, 2]);
    expect(parsePartial('{"a": 12}')).toEqual({ a: 12 });
  });

  const partial: Array<[input: string, expected: unknown]> = [
    ['[12', [12]],
    ['[-', []], // a lone minus determines nothing
    ['[-1', [-1]],
    ['[0', [0]],
    ['[12.', [12]], // the dangling '.' contributes nothing yet
    ['[12.5', [12.5]],
    ['[1e', [1]],
    ['[1e+', [1]],
    ['[1e+3', [1000]],
    ['[1.5e-3', [0.0015]],
  ];

  it.each(partial)('with partialNumbers: %j → %j', (input, expected) => {
    expect(parsePartial(input, { partialNumbers: true })).toEqual(expected);
  });

  it('parses the full numeric grammar', () => {
    expect(parsePartial('[0, -0, 1e3, -1.5E-2, 1E+2]')).toEqual(
      JSON.parse('[0, -0, 1e3, -1.5E-2, 1E+2]'),
    );
  });
});

describe('literals', () => {
  // Resolving these early is safe rather than a guess: in valid JSON no token
  // other than `true` starts with `tru`.
  const cases: Array<[input: string, expected: unknown]> = [
    ['[t', [true]],
    ['[tr', [true]],
    ['[tru', [true]],
    ['[true', [true]],
    ['[f', [false]],
    ['[fals', [false]],
    ['[n', [null]],
    ['[nul', [null]],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(parsePartial(input)).toEqual(expected);
  });

  it('rejects a literal that has already gone wrong', () => {
    expect(parsePartial('[tx')).toEqual([]);
    expect(parsePartial('[nope')).toEqual([]);
  });
});

describe('nothing determinable', () => {
  const cases = ['', '   ', 'hello', '}', ']', ':', ',', '-', 'undefined'];

  it.each(cases)('%j → undefined', (input) => {
    expect(parsePartial(input)).toBeUndefined();
  });
});

describe('never throws', () => {
  const hostile = [
    '',
    '{'.repeat(2000),
    '['.repeat(2000),
    '{"a": "\\',
    '\u0000\u0001\u0002',
    '{"a": "x", , , }',
    '[,,,]',
    '{"a" "b"}',
    '{"__proto__": {"polluted": true}}',
    '"\\uZZZZ"',
    '[1,2,3',
  ];

  it.each(hostile)('survives %j', (input) => {
    expect(() => parsePartial(input)).not.toThrow();
    expect(() => parsePartial(input, { partialNumbers: true })).not.toThrow();
    expect(() => parsePartial(input, { streaming: false })).not.toThrow();
  });

  it('returns undefined for non-string input', () => {
    // Defensive: JS callers do reach here with a Buffer or null.
    expect(parsePartial(null as unknown as string)).toBeUndefined();
    expect(parsePartial(undefined as unknown as string)).toBeUndefined();
    expect(parsePartial(42 as unknown as string)).toBeUndefined();
    expect(parsePartialResult(null as unknown as string)).toEqual({
      value: undefined,
      complete: false,
    });
  });
});

describe('prototype pollution', () => {
  it('does not let __proto__ reach the prototype chain', () => {
    const result = parsePartial<Record<string, unknown>>(
      '{"__proto__": {"polluted": true}}',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result!)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
  });

  it('matches JSON.parse for a __proto__ key', () => {
    const text = '{"__proto__": {"polluted": true}}';
    expect(parsePartial(text)).toEqual(JSON.parse(text));
  });

  it('creates a __proto__ property with exactly JSON.parse’s descriptor', () => {
    const text = '{"__proto__": 1}';
    expect(Object.getOwnPropertyDescriptor(parsePartial(text), '__proto__')).toEqual(
      Object.getOwnPropertyDescriptor(JSON.parse(text), '__proto__'),
    );
  });

  it('lets a repeated __proto__ key be overwritten, as JSON.parse does', () => {
    // Requires the property to be redefinable; a non-configurable descriptor
    // would throw on the second assignment.
    const text = '{"__proto__": 1, "__proto__": 2}';
    expect(() => parsePartial(text)).not.toThrow();
    expect(parsePartial(text)).toEqual(JSON.parse(text));
  });

  it('handles a partial __proto__ key too', () => {
    expect(() => parsePartial('{"__proto__": {"polluted": tru')).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('completeness reporting', () => {
  it('distinguishes a closed document from a stalled one', () => {
    expect(parsePartialResult('{"a": 1}')).toEqual({
      value: { a: 1 },
      complete: true,
    });
    expect(parsePartialResult('{"a": 1')).toEqual({ value: {}, complete: false });
    expect(parsePartialResult('[1, 2]')).toEqual({
      value: [1, 2],
      complete: true,
    });
    expect(parsePartialResult('')).toEqual({ value: undefined, complete: false });
  });

  it('reports a bare scalar as incomplete while streaming', () => {
    // `123` could still be growing, so we cannot call it finished.
    expect(parsePartialResult('123')).toEqual({
      value: undefined,
      complete: false,
    });
    expect(parsePartialResult('123', { streaming: false })).toEqual({
      value: 123,
      complete: true,
    });
  });
});

describe('streaming: false (salvage a truncated final buffer)', () => {
  it('treats end of input as the end of the last token', () => {
    expect(parsePartial('{"a": 12', { streaming: false })).toEqual({ a: 12 });
    expect(parsePartial('{"a": "hel', { streaming: false })).toEqual({
      a: 'hel',
    });
    expect(parsePartial('123', { streaming: false })).toBe(123);
    expect(parsePartial('"abc"', { streaming: false })).toBe('abc');
  });

  it('still recovers the surrounding structure', () => {
    expect(
      parsePartial('{"items": [{"id": 1, "name": "wid', { streaming: false }),
    ).toEqual({ items: [{ id: 1, name: 'wid' }] });
  });
});

describe('unicode escape validation', () => {
  it('accepts the first and last character of every hex range', () => {
    // `0`,`9`,`a`,`f`,`A`,`F` are the exact endpoints of the three valid
    // ranges. An off-by-one at an endpoint rejects a single real code point —
    // a bound of `> 'A'` instead of `>= 'A'` breaks `©` and nothing else,
    // which is exactly the bug no hand-picked example catches.
    expect(parsePartial('["\\u0A0F\\u9a9f\\u00A9"]')).toEqual([
      'ਏ骟©',
    ]);
  });

  it('accepts every hex class', () => {
    expect(parsePartial('["\\u0039\\u002f\\u00FF\\u00ab\\u00CD"]')).toEqual([
      '\u0039\u002f\u00FF\u00ab\u00CD',
    ]);
  });

  // Characters that sit immediately outside each hex range. If the validator's
  // bounds were off by one, one of these would be silently accepted and decode
  // to garbage instead of falling through to lenient handling.
  const justOutsideHex = [
    ['["\\u00/0"]', 'u00/0'], // '/' is one below '0'
    ['["\\u00:0"]', 'u00:0'], // ':' is one above '9'
    ['["\\u00@0"]', 'u00@0'], // '@' is one below 'A'
    ['["\\u00G0"]', 'u00G0'], // 'G' is one above 'F'
    ['["\\u00`0"]', 'u00`0'], // '`' is one below 'a'
    ['["\\u00g0"]', 'u00g0'], // 'g' is one above 'f'
  ] as const;

  it.each(justOutsideHex)('treats %j as a non-escape → %j', (input, expected) => {
    expect(parsePartial(input)).toEqual([expected]);
  });

  it('checks every one of the four hex digits', () => {
    // A validator that only inspected some positions would accept these.
    expect(parsePartial('["\\uZ000"]')).toEqual(['uZ000']);
    expect(parsePartial('["\\u0Z00"]')).toEqual(['u0Z00']);
    expect(parsePartial('["\\u00Z0"]')).toEqual(['u00Z0']);
    expect(parsePartial('["\\u000Z"]')).toEqual(['u000Z']);
  });
});

describe('whitespace', () => {
  it('accepts every whitespace character JSON allows, anywhere', () => {
    expect(parsePartial('{\t"a"\n:\r1\t,\n"b"\r:\t2\n}')).toEqual({ a: 1, b: 2 });
    expect(parsePartial('[\t1\n,\r2\t]')).toEqual([1, 2]);
  });

  it.each(['\t', '\n', '\r', ' '])(
    'treats %j as a delimiter that finishes a number',
    (ws) => {
      expect(parsePartial(`[1${ws}, 2]`)).toEqual([1, 2]);
    },
  );

  it('does not treat other characters as whitespace', () => {
    // A vertical tab counts as whitespace to most regexes but not to JSON,
    // so it ends the document instead of being skipped over.
    expect(parsePartial('{\u000b"a": 1}')).toEqual({});
    expect(parsePartial('[1\u000b, 2]')).toEqual([1]);
  });
});

describe('malformed input stops cleanly', () => {
  it('keeps what came before a bad token in an array', () => {
    expect(parsePartialResult('[1 2')).toEqual({ value: [1], complete: false });
    // The space after `2` already terminated it, so `2` is kept; only the
    // stray string that follows stops the scan.
    expect(parsePartialResult('[1, 2 "x"')).toEqual({
      value: [1, 2],
      complete: false,
    });
  });

  it('keeps what came before a bad token in an object', () => {
    expect(parsePartialResult('{"a": 1 "b"')).toEqual({
      value: { a: 1 },
      complete: false,
    });
    expect(parsePartialResult('{"a" 1}')).toEqual({ value: {}, complete: false });
    expect(parsePartialResult('{1: 2}')).toEqual({ value: {}, complete: false });
  });

  it('never reports a malformed document as complete', () => {
    for (const bad of ['[1 2', '{"a": 1 "b"', '[1,', '{"a":', '[tx']) {
      expect(parsePartialResult(bad).complete).toBe(false);
    }
  });
});

describe('option defaults are applied per-option', () => {
  it('specifying one option does not silently disable the others', () => {
    // A `??` that degraded into `&&` would turn an unspecified option into
    // `undefined`, which is falsy, quietly switching the default off.
    expect(parsePartial('{"a": "he', { partialNumbers: true })).toEqual({
      a: 'he',
    });
    expect(parsePartialResult('123', { partialNumbers: true })).toEqual({
      value: 123,
      complete: false,
    });
    expect(parsePartial('{"a": "he', {})).toEqual({ a: 'he' });
  });
});

describe('completeness of half-arrived atoms', () => {
  // Each of these is `complete: false` while streaming, and `true` once the
  // caller declares the buffer final.
  const atoms: Array<[text: string, value: unknown]> = [
    ['tru', true],
    ['fals', false],
    ['nul', null],
    ['"ab', 'ab'],
    ['12', 12],
  ];

  it.each(atoms)('%j is incomplete while streaming', (text) => {
    expect(parsePartialResult(text).complete).toBe(false);
  });

  it.each(atoms)('%j resolves to %j once final', (text, value) => {
    expect(parsePartialResult(text, { streaming: false })).toEqual({
      value,
      complete: true,
    });
  });

  it('reports a closed atom as complete even mid-stream', () => {
    expect(parsePartialResult('true')).toEqual({ value: true, complete: true });
    expect(parsePartialResult('"ab"')).toEqual({ value: 'ab', complete: true });
  });
});

describe('the streaming use case, end to end', () => {
  it('only ever grows as chunks arrive', () => {
    const full = '{"title": "Hello", "tags": ["a", "b"], "done": true}';
    const seen: string[] = [];
    for (let i = 0; i <= full.length; i++) {
      seen.push(JSON.stringify(parsePartial(full.slice(0, i))));
    }
    expect(seen[seen.length - 1]).toBe(JSON.stringify(JSON.parse(full)));

    // Spot-check the frames a UI would actually render, sliced at landmarks in
    // the text rather than at hand-counted offsets.
    expect(parsePartial(full.slice(0, full.indexOf('lo"')))).toEqual({
      title: 'Hel',
    });
    expect(parsePartial(full.slice(0, full.indexOf('", "b"')))).toEqual({
      title: 'Hello',
      tags: ['a'],
    });
    expect(parsePartial(full.slice(0, full.indexOf('"done"')))).toEqual({
      title: 'Hello',
      tags: ['a', 'b'],
    });
  });
});

/**
 * Settledness — which individual paths have stopped changing.
 *
 * As with the emission table above, these rows are the specification. A path is
 * settled when the token holding it was closed by its own syntax, so changing a
 * row changes the contract.
 */
describe('settled paths', () => {
  const settled = (text: string, options?: Parameters<typeof parseSettled>[1]) =>
    parseSettled(text, options).settledPaths();

  describe('a string settles when its closing quote is consumed', () => {
    const cases: Array<[string, string[]]> = [
      ['{"s": "', []],
      ['{"s": "ab', []],
      ['{"s": "ab"', ['/s']],
      ['{"s": "ab"}', ['', '/s']],
    ];
    it.each(cases)('%j → %j', (input, expected) => {
      expect(settled(input)).toEqual(expected);
    });
  });

  describe('a number settles when a delimiter follows it', () => {
    const cases: Array<[string, string[]]> = [
      ['{"n": 1', []], // 1 may still become 10
      ['{"n": 1 ', ['/n']], // whitespace is a delimiter
      ['{"n": 1,', ['/n']],
      ['{"n": 1}', ['', '/n']],
      ['[1, 2', ['/0']],
      ['[1, 2]', ['', '/0', '/1']],
    ];
    it.each(cases)('%j → %j', (input, expected) => {
      expect(settled(input)).toEqual(expected);
    });

    it('settles at end of input only when the caller says input is final', () => {
      expect(settled('{"n": 1')).toEqual([]);
      expect(settled('{"n": 1', { streaming: false })).toEqual(['/n']);
    });
  });

  describe('a literal settles as soon as it is unambiguous', () => {
    // No JSON literal is a prefix of another, so the value is known before the
    // token finishes — but the token must still complete to settle.
    const cases: Array<[string, string[]]> = [
      ['[tru', []],
      ['[true', ['/0']],
      ['[true]', ['', '/0']],
      ['[fals', []],
      ['[false', ['/0']],
      ['[nul', []],
      ['[null', ['/0']],
    ];
    it.each(cases)('%j → %j', (input, expected) => {
      expect(settled(input)).toEqual(expected);
    });
  });

  describe('containers settle when their bracket is consumed', () => {
    const cases: Array<[string, string[]]> = [
      ['[', []],
      ['[]', ['']],
      ['{', []],
      ['{}', ['']],
      ['{"o": {', []],
      ['{"o": {}', ['/o']],
      ['{"o": {}}', ['', '/o']],
      ['{"a": []', ['/a']],
      ['{"a": []}', ['', '/a']],
    ];
    it.each(cases)('%j → %j', (input, expected) => {
      expect(settled(input)).toEqual(expected);
    });
  });

  describe('nesting', () => {
    it('settles the anchor example from the design', () => {
      // The unsettled spine is ['b', 1]: the object, `b`, and `b[1]` are all
      // unsettled; everything off that chain is settled.
      const r = parseSettled('{"a": 1, "b": [10, 2');
      expect(r.settledPaths()).toEqual(['/a', '/b/0']);
      expect(r.isSettled()).toBe(false);
      expect(r.isSettled('a')).toBe(true);
      expect(r.isSettled('b')).toBe(false);
      expect(r.isSettled('b', 0)).toBe(true);
      expect(r.isSettled('b', 1)).toBe(false);
    });

    it('settles a closed inner container inside an open outer one', () => {
      expect(settled('[[1]')).toEqual(['/0', '/0/0']);
      expect(settled('[[1]]')).toEqual(['', '/0', '/0/0']);
    });

    it('settles every path once the whole document closes', () => {
      expect(settled('{"a": {"b": [1, 2]}}')).toEqual([
        '',
        '/a',
        '/a/b',
        '/a/b/0',
        '/a/b/1',
      ]);
    });
  });

  describe('paths that do not exist are never settled', () => {
    it.each([
      ['nope'],
      ['a', 'deeper'],
      ['0'],
    ])('isSettled(%j, ...) → false', (...path) => {
      expect(parseSettled('{"a": 1}').isSettled(...path)).toBe(false);
    });

    it('treats an out-of-range index as absent', () => {
      const r = parseSettled('[1, 2]');
      expect(r.isSettled(1)).toBe(true);
      expect(r.isSettled(2)).toBe(false);
      expect(r.isSettled(-1)).toBe(false);
    });

    it('returns false for everything when nothing parsed', () => {
      const r = parseSettled('not json');
      expect(r.value).toBeUndefined();
      expect(r.isSettled()).toBe(false);
      expect(r.settledPaths()).toEqual([]);
    });
  });

  describe('JSON Pointer encoding', () => {
    it('escapes ~ and / in keys, per RFC 6901', () => {
      expect(settled('{"a/b": 1, "c~d": 2}')).toEqual(['', '/a~1b', '/c~0d']);
    });

    it('uses the empty string for the root', () => {
      expect(parseSettled('{}').settledPaths()).toEqual(['']);
    });

    it('sorts shortest-first, then lexicographically', () => {
      expect(settled('{"b": 1, "a": 2, "c": {"d": 3}}')).toEqual([
        '',
        '/a',
        '/b',
        '/c',
        '/c/d',
      ]);
    });
  });

  describe('the root always agrees with `complete`', () => {
    const inputs = [
      '',
      '{',
      '{"a": 1',
      '{"a": 1}',
      '[1, 2',
      '[1, 2]',
      '123',
      'true',
      'not json',
    ];
    it.each(inputs)('%j', (input) => {
      const r = parseSettled(input);
      expect(r.isSettled()).toBe(r.complete);
      expect(r.complete).toBe(parsePartialResult(input).complete);
    });
  });

  describe('emitted and settled are independent', () => {
    it('is unaffected by partialNumbers', () => {
      // partialNumbers decides whether the value appears, never whether the
      // path is final. An unterminated number is unsettled either way.
      expect(settled('{"a": 12', { partialNumbers: true })).toEqual([]);
      expect(settled('{"a": 12', { partialNumbers: false })).toEqual([]);
      expect(parseSettled('{"a": 12', { partialNumbers: true }).value).toEqual({
        a: 12,
      });
      expect(parseSettled('{"a": 12', { partialNumbers: false }).value).toEqual({});
    });

    it('is unaffected by partialStrings', () => {
      expect(settled('{"a": "hi', { partialStrings: true })).toEqual([]);
      expect(settled('{"a": "hi', { partialStrings: false })).toEqual([]);
    });
  });

  describe('value is identical to parsePartial', () => {
    it.each(['{"a": 1, "b": [10, 2', '{"s": "ab', '[true', '', 'garbage'])(
      '%j',
      (input) => {
        expect(parseSettled(input).value).toEqual(parsePartial(input));
      },
    );
  });

  describe('path segments', () => {
    // Indices may arrive as numbers or as canonical decimal strings. Anything
    // else names nothing — notably `length`, which is a real own property of an
    // array and would resolve if indices were looked up like object keys.
    const eleven = parseSettled('[0,1,2,3,4,5,6,7,8,9,10]');

    it.each([
      [0, true],
      [1, true],
      [10, true],
      ['0', true],
      ['1', true],
      ['10', true],
    ])('accepts index %j → %j', (segment, expected) => {
      expect(eleven.isSettled(segment)).toBe(expected);
    });

    it.each([
      ['00'], // not canonical
      ['01'], // leading zero
      ['1x'], // trailing junk
      ['x1'], // leading junk
      [''], // Number('') is 0, which must not resolve
      ['length'], // a real own property of the array
      ['1.0'],
      [' 1'],
      [11], // out of range
      [-1],
      [1.5],
    ])('rejects segment %j', (segment) => {
      expect(eleven.isSettled(segment)).toBe(false);
    });

    it('does not descend through null', () => {
      // `typeof null === 'object'`, so treating it as one would reach
      // hasOwnProperty.call(null, ...) and throw.
      const r = parseSettled('{"a": null}');
      expect(r.isSettled('a')).toBe(true);
      expect(() => r.isSettled('a', 'b')).not.toThrow();
      expect(r.isSettled('a', 'b')).toBe(false);
    });

    it('does not descend through a scalar', () => {
      const r = parseSettled('{"a": 1, "b": "s"}');
      expect(r.isSettled('a', 'x')).toBe(false);
      expect(r.isSettled('b', 0)).toBe(false);
    });

    it('reports nothing settled when no value parsed', () => {
      // Absence is not finality: with no value, no path is settled — including
      // paths that were never there to begin with.
      for (const text of ['', 'not json', '-']) {
        const r = parseSettled(text);
        expect(r.isSettled()).toBe(false);
        expect(r.isSettled('a')).toBe(false);
        expect(r.isSettled('a', 'b')).toBe(false);
        expect(r.isSettled(0)).toBe(false);
        expect(r.settledPaths()).toEqual([]);
      }
    });

    it('returns a safe empty result for non-string input', () => {
      for (const bad of [null, undefined, 42, {}, ['x']]) {
        const r = parseSettled(bad as unknown as string);
        expect(r.value).toBeUndefined();
        expect(r.complete).toBe(false);
        expect(r.isSettled()).toBe(false);
        expect(r.isSettled('a')).toBe(false);
        expect(r.settledPaths()).toEqual([]);
      }
    });
  });

  describe('the spine is ordered root-first', () => {
    it('settles only off a three-deep spine', () => {
      // Spine ['x','y',1]. If the recorded chain were leaf-first, `/x` and
      // `/x/y` would wrongly settle and `/x/y/0` would not.
      const r = parseSettled('{"x": {"y": [1, 2');
      expect(r.settledPaths()).toEqual(['/x/y/0']);
      expect(r.isSettled('x')).toBe(false);
      expect(r.isSettled('x', 'y')).toBe(false);
      expect(r.isSettled('x', 'y', 0)).toBe(true);
    });

    it('does not treat a longer path as a prefix of the spine', () => {
      // A key literally named `undefined` catches comparing past the end of
      // the spine, where the missing segment stringifies to "undefined".
      const r = parseSettled('{"a": {"undefined": 1, "x": 2');
      expect(r.settledPaths()).toEqual(['/a/undefined']);
      expect(r.isSettled('a', 'undefined')).toBe(true);
      expect(r.isSettled('a')).toBe(false);
    });
  });

  describe('ordering is total and deterministic', () => {
    it('breaks length ties lexicographically, whatever the key order', () => {
      const r = parseSettled('{"d": 1, "b": 2, "a": 3, "c": 4}');
      expect(r.settledPaths()).toEqual(['', '/a', '/b', '/c', '/d']);
    });

    it('orders by length before lexicography', () => {
      // '/zz' sorts after '/a' by length even though 'z' > 'a' either way;
      // '/a/b' is longer than '/zz' and must come last.
      const r = parseSettled('{"zz": {"q": 1}, "a": 2}');
      expect(r.settledPaths()).toEqual(['', '/a', '/zz', '/zz/q']);
    });

    it('is stable across repeated calls', () => {
      const r = parseSettled('{"b": 1, "a": {"d": 2, "c": 3}}');
      expect(r.settledPaths()).toEqual(r.settledPaths());
      expect(r.settledPaths()).toEqual(['', '/a', '/b', '/a/c', '/a/d']);
    });
  });

  // The one case where settledness is not permanent. Documented in the README
  // rather than worked around: last-wins matches JSON.parse, and detecting it
  // would mean withholding every key until the object closes.
  describe('duplicate keys rebind a settled path', () => {
    it('reports settled, then changes value when the key is rebound', () => {
      const first = parseSettled<{ a: number }>('{"a": 1,');
      expect(first.isSettled('a')).toBe(true);
      expect(first.value?.a).toBe(1);

      const second = parseSettled<{ a: number }>('{"a": 1, "a": 2}');
      expect(second.value?.a).toBe(2);
      expect(second.isSettled('a')).toBe(true);
    });

    it('matches JSON.parse on the completed document', () => {
      const text = '{"a": 1, "a": 2}';
      expect(parseSettled(text).value).toEqual(JSON.parse(text));
    });
  });
});
