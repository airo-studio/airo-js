/**
 * Text-level helpers for CSS values: finding function calls, substituting
 * `var()` from a token table, and evaluating static `calc()`.
 *
 * The normaliser walks rules and declarations with css-tree, but rewrites
 * values as text: a declaration value is short, and the rewrites here
 * (replace a call with its result) are simpler on a string than on a value
 * AST that would have to be regenerated anyway.
 */

/** A `--name` → raw value table: the custom properties one theme declares on `:root`. */
export type TokenTable = ReadonlyMap<string, string>;

/** Thrown when a value refers to something the build cannot see. Carries the offending text. */
export class UnresolvableValueError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'UnresolvableValueError';
  }
}

/** Index just past the `)` that closes the `(` at `open`, honouring nesting and quotes. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new UnresolvableValueError(`unbalanced parentheses in "${text}"`, text);
}

export interface Call {
  /** Index of the function name's first character. */
  start: number;
  /** Index just past the closing `)`. */
  end: number;
  /** Text between the parentheses. */
  inner: string;
}

/**
 * The first call of `name(` at or after `from`, case-insensitive, not inside
 * a quoted string and not the tail of a longer identifier (`--my-var(` is
 * not a `var(` call).
 */
function findCall(text: string, name: string, from = 0): Call | null {
  const lower = text.toLowerCase();
  const needle = `${name.toLowerCase()}(`;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (lower.startsWith(needle, i) && !/[\w-]/.test(text[i - 1] ?? '')) {
      const open = i + name.length;
      const end = closeParen(text, open);
      return { start: i, end, inner: text.slice(open + 1, end - 1) };
    }
  }
  return null;
}

/** Replace every call of `name(` with `fn(call)`, innermost-first is the caller's job. */
export function replaceCalls(text: string, name: string, fn: (call: Call) => string): string {
  let out = '';
  let cursor = 0;
  let call = findCall(text, name, cursor);
  while (call) {
    out += text.slice(cursor, call.start) + fn(call);
    cursor = call.end;
    call = findCall(text, name, cursor);
  }
  return out + text.slice(cursor);
}

/** Split at top-level occurrences of `sep` (outside parentheses and quotes), trimmed. */
export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && (sep === ' ' ? /\s/.test(char) : char === sep)) {
      parts.push(text.slice(last, i).trim());
      last = i + 1;
    }
  }
  parts.push(text.slice(last).trim());
  return sep === ' ' ? parts.filter(Boolean) : parts;
}

/**
 * Substitute every `var(--name[, fallback])` from `tokens`, recursively,
 * until none is left. A name the table lacks uses its fallback; with no
 * fallback it is unresolvable, and the build should say so rather than
 * guess.
 */
export function resolveVars(text: string, tokens: TokenTable, seen: ReadonlySet<string> = new Set()): string {
  return replaceCalls(text, 'var', ({ inner }) => {
    const [rawName, ...rest] = splitTopLevel(inner, ',');
    const name = rawName!.trim();
    const fallback = rest.length ? rest.join(',').trim() : null;
    if (seen.has(name)) {
      throw new UnresolvableValueError(`custom property cycle through ${name}`, name);
    }
    const value = tokens.get(name);
    if (value !== undefined) return resolveVars(value, tokens, new Set([...seen, name]));
    if (fallback !== null) return resolveVars(fallback, tokens, seen);
    throw new UnresolvableValueError(
      `${name} is not a :root token, so its value is not known at build time`,
      name,
    );
  });
}

// ── calc() ──────────────────────────────────────────────────────────────────

/** A linear combination of units: `{ px: 4, rem: 0.75 }` is `0.75rem + 4px`. */
type Linear = Map<string, number>;

const scale = (a: Linear, k: number): Linear => new Map([...a].map(([u, v]) => [u, v * k]));

function add(a: Linear, b: Linear, sign: 1 | -1): Linear {
  const out = new Map(a);
  for (const [u, v] of b) out.set(u, (out.get(u) ?? 0) + sign * v);
  return out;
}

const scalarOf = (a: Linear): number | null =>
  [...a].every(([u, v]) => u === '' || v === 0) ? (a.get('') ?? 0) : null;

/** Units whose value is fixed at build time once the page font-size is 16px. */
const STATIC_UNITS = new Set(['', 'px', 'rem']);

const TOKEN = /\s*(?:(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)|([-+*/()]))/iy;

/**
 * Evaluate a `calc()` body whose operands are numbers, `px` and `rem`.
 * Returns `null` when the result depends on the element or the viewport
 * (`%`, `em`, `vw`, `env()`, …): that value is not static and stays as the
 * author wrote it.
 */
function evaluate(body: string): Linear | null {
  const tokens: string[][] = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  const src = body.replace(/calc\(/gi, '(');
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) return null;
    tokens.push(m[3] !== undefined ? ['op', m[3]] : ['num', m[1]!, m[2]!.toLowerCase()]);
    pos = TOKEN.lastIndex;
  }
  let i = 0;
  const peek = (): string[] | undefined => tokens[i];
  const expr = (): Linear | null => {
    let left = term();
    while (left && peek()?.[0] === 'op' && (peek()![1] === '+' || peek()![1] === '-')) {
      const op = tokens[i++]![1];
      const right = term();
      if (!right) return null;
      left = add(left, right, op === '+' ? 1 : -1);
    }
    return left;
  };
  const term = (): Linear | null => {
    let left = factor();
    while (left && peek()?.[0] === 'op' && (peek()![1] === '*' || peek()![1] === '/')) {
      const op = tokens[i++]![1];
      const right = factor();
      if (!right) return null;
      const k = scalarOf(right);
      const kl = scalarOf(left);
      if (op === '*') {
        if (k !== null) left = scale(left, k);
        else if (kl !== null) left = scale(right, kl);
        else return null;
      } else {
        if (k === null || k === 0) return null;
        left = scale(left, 1 / k);
      }
    }
    return left;
  };
  const factor = (): Linear | null => {
    const t = tokens[i++];
    if (!t) return null;
    if (t[0] === 'op' && t[1] === '(') {
      const inner = expr();
      if (tokens[i++]?.[1] !== ')') return null;
      return inner;
    }
    if (t[0] === 'op' && t[1] === '-') {
      const inner = factor();
      return inner && scale(inner, -1);
    }
    if (t[0] !== 'num') return null;
    const unit = t[2]!;
    if (!STATIC_UNITS.has(unit)) return null;
    return new Map([[unit, Number(t[1])]]);
  };
  const result = expr();
  return result && i === tokens.length ? result : null;
}

const round = (n: number): string => String(Math.round(n * 10_000) / 10_000);

/**
 * `calc(var(--radius) + 4px)` with `--radius: 0.75rem` → `16px`. Units stay
 * as written when there is one (`calc(1rem * 2)` → `2rem`); `rem` mixed with
 * `px` is converted at 16px, the value the page rule pins. Returns `null` for
 * anything that is not static.
 */
export function evalCalc(text: string, tokens: TokenTable): string | null {
  let resolved: string;
  try {
    resolved = resolveVars(text, tokens);
  } catch {
    return null;
  }
  if (/env\(|min\(|max\(|clamp\(/i.test(resolved)) return null;
  const call = findCall(resolved, 'calc');
  if (call?.start !== 0 || call.end !== resolved.trim().length) return null;
  const value = evaluate(call.inner);
  if (!value) return null;
  const units = [...value].filter(([, v]) => v !== 0);
  if (units.length === 0) return '0';
  if (units.length === 1) {
    const [unit, v] = units[0]!;
    return unit === '' ? round(v) : `${round(v)}${unit}`;
  }
  if (units.every(([u]) => u === 'px' || u === 'rem')) {
    const px = (value.get('px') ?? 0) + (value.get('rem') ?? 0) * 16;
    return `${round(px)}px`;
  }
  return null;
}
