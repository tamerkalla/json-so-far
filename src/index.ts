/**
 * json-so-far — a best-effort parser for JSON that has not finished arriving.
 *
 * The problem: an LLM streams you `{"title": "The Rise of` and your UI has to
 * render something. `JSON.parse` throws. This returns `{ title: "The Rise of" }`.
 *
 * Design rules, in priority order:
 *
 *  1. **Never throw.** Any string in, a value or `undefined` out. No exceptions,
 *     for any input, ever. This is enforced by property tests.
 *  2. **Never guess forward.** Output is always a *prefix* of what the completed
 *     value will be. We emit what has definitely arrived and nothing more, so a
 *     rendered UI only ever grows — it never has to retract a wrong value.
 *  3. **Be explicit at the boundary.** Every decision about a half-arrived token
 *     is documented and table-tested, because that is exactly where other
 *     libraries in this space disagree with each other.
 *
 * Zero dependencies. Zero I/O. Pure function.
 */

/** Options controlling how half-arrived atoms are emitted. */
export interface ParseOptions {
  /**
   * Emit the characters of a string that have arrived so far.
   *
   * `'{"a": "hel'` → `{ a: 'hel' }` when `true`, `{}` when `false`.
   *
   * On by default: streaming prose is the main reason this library exists, and
   * a string prefix is always a truthful prefix of the final string.
   *
   * @default true
   */
  partialStrings?: boolean;

  /**
   * Emit the longest complete numeric prefix of a number still being received.
   *
   * `'{"a": 12'` → `{ a: 12 }` when `true`, `{}` when `false`.
   *
   * **Off by default, deliberately.** Unlike strings, a truncated number is not
   * a harmless prefix of the final value — it is a *different number*. `12` is
   * a prefix of the text `125`, but rendering "12" to a user who will shortly
   * see "125" is a lie, and `0.5` truncated to `0` inverts its meaning. Turn
   * this on only when a jittery number is better than a missing one.
   *
   * @default false
   */
  partialNumbers?: boolean;

  /**
   * Whether more input may still arrive.
   *
   * When `true` (the default), a token that runs to the end of the buffer is
   * treated as unfinished, because it could still grow — `123` might become
   * `1234`, and `"ab` will certainly become something longer.
   *
   * Set to `false` when you hold the *final* buffer and simply want to salvage
   * whatever is there — the classic "the model hit its token limit mid-object"
   * repair case. End-of-input then terminates the last token instead of
   * invalidating it, and `partialStrings` / `partialNumbers` no longer apply
   * because nothing is partial any more.
   *
   * @default true
   */
  streaming?: boolean;
}

/** A parse result together with whether the value is known to be finished. */
export interface ParseResult<T> {
  /** The value recovered so far, or `undefined` if nothing was determinable. */
  value: T | undefined;
  /**
   * `true` when the value was closed off by its own syntax (a `}`, `]`, or
   * closing quote) and therefore cannot grow. A `false` here means "keep
   * feeding me" — it does not mean the input was malformed.
   */
  complete: boolean;
}

interface ResolvedOptions {
  partialStrings: boolean;
  partialNumbers: boolean;
  streaming: boolean;
}

/**
 * A parsed value plus whether its own syntax terminated it. `null` is used for
 * "nothing determinable here" — deliberately distinct from a determinable JSON
 * `null`, which is `{ v: null, done: true }`.
 */
type Node = { v: unknown; done: boolean } | null;

const DEFAULTS: ResolvedOptions = {
  partialStrings: true,
  partialNumbers: false,
  streaming: true,
};

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** Callers guarantee exactly four characters, so there is no length check here. */
function isHex4(s: string): boolean {
  for (let k = 0; k < 4; k++) {
    const c = s[k];
    const ok =
      (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    if (!ok) return false;
  }
  return true;
}

/**
 * The escapes that decode to something other than themselves. `\"`, `\\` and
 * `\/` are deliberately absent: they decode to the escaped character, which is
 * exactly what the fallback does.
 */
const ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Assign a key without letting `__proto__` reach the prototype chain.
 *
 * `obj['__proto__'] = v` invokes the inherited setter and mutates the object's
 * prototype instead of creating a property — the classic prototype-pollution
 * sink, and a live bug in more than one JSON-repair package. `defineProperty`
 * creates a plain own property, which is also exactly what `JSON.parse` does.
 */
function assign(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

function parseNodes(src: string, opts: ResolvedOptions): Node {
  const n = src.length;
  let i = 0;

  function skipWhitespace(): void {
    while (i < n) {
      const c = src.charCodeAt(i);
      // space, tab, newline, carriage return — the only whitespace JSON allows
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  }

  function parseKeyword(word: string, value: unknown): Node {
    let k = 0;
    while (k < word.length && i + k < n && src[i + k] === word[k]) k++;

    if (k === word.length) {
      i += k;
      return { v: value, done: true };
    }
    if (i + k >= n) {
      // A proper prefix that ran into the end of the buffer. This is safe to
      // resolve: in valid JSON nothing but `true` can begin with `tru`, so the
      // value is already known even though the text is not finished.
      i = n;
      return { v: value, done: !opts.streaming };
    }
    // Mismatch with input still to spare — malformed, not partial.
    return null;
  }

  function parseNumber(): Node {
    const start = i;
    let p = start;
    /** Exclusive end of the longest prefix that is a *complete* JSON number. */
    let valid = -1;

    if (p < n && src[p] === '-') p++;

    if (p < n && src[p] === '0') {
      p++;
      valid = p;
    } else if (p < n && isDigit(src[p])) {
      while (p < n && isDigit(src[p])) p++;
      valid = p;
    } else {
      // A lone `-`, or `-` followed by something that is not a digit.
      i = p;
      return null;
    }

    let truncatedComponent = false;

    if (p < n && src[p] === '.') {
      let q = p + 1;
      const firstFractionDigit = q;
      while (q < n && isDigit(src[q])) q++;
      if (q > firstFractionDigit) {
        valid = q;
        p = q;
      } else {
        // A trailing `.` with no digits yet.
        p = q;
        truncatedComponent = true;
      }
    }

    if (!truncatedComponent && p < n && (src[p] === 'e' || src[p] === 'E')) {
      let q = p + 1;
      if (q < n && (src[q] === '+' || src[q] === '-')) q++;
      const firstExponentDigit = q;
      while (q < n && isDigit(src[q])) q++;
      if (q > firstExponentDigit) {
        valid = q;
        p = q;
      } else {
        // A trailing `e`, `e+` or `e-` with no digits yet.
        p = q;
        truncatedComponent = true;
      }
    }

    i = p;

    // The token is finished only if some non-numeric character terminated it
    // and no component was left dangling. Numbers have no closing delimiter of
    // their own, so running to the end of the buffer always means "maybe more".
    let done = !truncatedComponent && valid === p && p < n;
    if (!done && !opts.streaming) done = true;

    if (!done && !opts.partialNumbers) return null;
    return { v: Number(src.slice(start, valid)), done };
  }

  function parseString(): Node {
    let p = i + 1; // skip the opening quote
    let out = '';

    while (p < n) {
      const c = src[p];

      if (c === '"') {
        i = p + 1;
        return { v: out, done: true };
      }

      if (c !== '\\') {
        out += c;
        p++;
        continue;
      }

      const esc = src[p + 1];
      if (esc === undefined) {
        // A backslash as the very last character. Drop it: we cannot know what
        // it will escape, and emitting a bare `\` would not be a prefix of the
        // decoded string.
        break;
      }

      if (esc === 'u') {
        const hex = src.slice(p + 2, p + 6);
        if (hex.length < 4) {
          // `\u12` at the end of the buffer — the code point is not knowable
          // yet, so emit the string without it.
          p = n;
          break;
        }
        if (!isHex4(hex)) {
          // Malformed rather than partial. Be lenient and keep going.
          out += 'u';
          p += 2;
        } else {
          // Appending code units one at a time keeps surrogate pairs working:
          // a lone high surrogate is joined by its partner on the next chunk.
          out += String.fromCharCode(parseInt(hex, 16));
          p += 6;
        }
      } else {
        // `\b`-style escapes decode via the table; everything else — including
        // `\"`, `\\`, `\/` and the non-standard escapes models emit — decodes
        // to the escaped character itself.
        out += ESCAPES[esc] ?? esc;
        p += 2;
      }
    }

    // Ran out of input before the closing quote.
    i = n;
    if (!opts.streaming) return { v: out, done: true };
    if (!opts.partialStrings) return null;
    return { v: out, done: false };
  }

  function parseArray(): Node {
    i++; // consume '['
    const arr: unknown[] = [];

    for (;;) {
      skipWhitespace();
      if (i >= n) return { v: arr, done: false };
      if (src[i] === ']') {
        i++;
        return { v: arr, done: true };
      }

      const element = parseValue();
      if (element === null) return { v: arr, done: false };
      arr.push(element.v);
      // An unfinished element means nothing can follow it yet.
      if (!element.done) return { v: arr, done: false };

      skipWhitespace();
      if (i >= n) return { v: arr, done: false };
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ']') {
        i++;
        return { v: arr, done: true };
      }
      return { v: arr, done: false };
    }
  }

  function parseObject(): Node {
    i++; // consume '{'
    const obj: Record<string, unknown> = {};

    for (;;) {
      skipWhitespace();
      if (i >= n) return { v: obj, done: false };
      if (src[i] === '}') {
        i++;
        return { v: obj, done: true };
      }
      if (src[i] !== '"') return { v: obj, done: false };

      // A key is all-or-nothing. A half-arrived key names nothing, and a key
      // whose value has not started yet would have to be paired with a guess.
      const key = parseString();
      if (key === null || !key.done) return { v: obj, done: false };

      skipWhitespace();
      if (i >= n || src[i] !== ':') return { v: obj, done: false };
      i++;

      const value = parseValue();
      if (value === null) return { v: obj, done: false };
      assign(obj, key.v as string, value.v);
      if (!value.done) return { v: obj, done: false };

      skipWhitespace();
      if (i >= n) return { v: obj, done: false };
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === '}') {
        i++;
        return { v: obj, done: true };
      }
      return { v: obj, done: false };
    }
  }

  function parseValue(): Node {
    skipWhitespace();
    if (i >= n) return null;

    const c = src[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') return parseKeyword('true', true);
    if (c === 'f') return parseKeyword('false', false);
    if (c === 'n') return parseKeyword('null', null);
    if (c === '-' || isDigit(c)) return parseNumber();
    return null;
  }

  return parseValue();
}

function resolve(options?: ParseOptions): ResolvedOptions {
  if (!options) return DEFAULTS;
  return {
    partialStrings: options.partialStrings ?? DEFAULTS.partialStrings,
    partialNumbers: options.partialNumbers ?? DEFAULTS.partialNumbers,
    streaming: options.streaming ?? DEFAULTS.streaming,
  };
}

/**
 * Parse as much of a possibly-incomplete JSON document as has definitely
 * arrived. Never throws.
 *
 * ```ts
 * parsePartial('{"title": "The Rise of')   // → { title: 'The Rise of' }
 * parsePartial('{"tags": ["ai", "js"')     // → { tags: ['ai', 'js'] }
 * parsePartial('not json at all')          // → undefined
 * ```
 *
 * Call it on the whole accumulated buffer after each chunk. The result only
 * ever grows, so rendering it directly is safe.
 *
 * @param text The bytes received so far. Non-strings yield `undefined`.
 * @param options See {@link ParseOptions}.
 * @returns The value so far, or `undefined` if nothing is determinable yet.
 */
export function parsePartial<T = unknown>(
  text: string,
  options?: ParseOptions,
): T | undefined {
  if (typeof text !== 'string') return undefined;
  const node = parseNodes(text, resolve(options));
  return node === null ? undefined : (node.v as T);
}

/**
 * Like {@link parsePartial}, but also reports whether the value is finished.
 *
 * `complete` is `true` only when the document's own syntax closed it, which
 * lets you tell "the object ended" apart from "the socket has not caught up".
 *
 * ```ts
 * parsePartialResult('{"a": 1}')   // → { value: { a: 1 }, complete: true }
 * parsePartialResult('{"a": 1')    // → { value: {},       complete: false }
 * ```
 */
export function parsePartialResult<T = unknown>(
  text: string,
  options?: ParseOptions,
): ParseResult<T> {
  if (typeof text !== 'string') return { value: undefined, complete: false };
  const node = parseNodes(text, resolve(options));
  if (node === null) return { value: undefined, complete: false };
  return { value: node.v as T, complete: node.done };
}
