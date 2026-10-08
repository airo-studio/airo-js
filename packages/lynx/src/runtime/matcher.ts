/**
 * The selectors hydrate code may use on device, matched against the JS node
 * model: type, `#id`, `.class`, `[attr]`, `[attr=value]` (quoted or not),
 * `*`, the descendant and child combinators, and comma lists. That covers
 * every `querySelector`, `closest` and `matches` call in the first
 * consumer's hydrate code that the facade does not refuse for other reasons.
 *
 * Anything else — pseudo-classes, sibling combinators, attribute operators
 * other than `=` — throws a refusal naming the selector, rather than
 * matching nothing and leaving a handler silently unwired.
 */

import { LynxRefusalError } from './errors.js';
import { descendants, type LynxElement } from './node-model.js';

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

/** Compounds right to left, each with the combinator that joins it to the next one leftwards. */
type Complex = { compound: Compound; combinator: ' ' | '>' | null }[];

export class UnsupportedSelectorError extends LynxRefusalError {
  constructor(selector: string, reason: string) {
    super(`selector "${selector}"`, `${reason}; the device supports type, #id, .class, [attr], [attr=value], descendant, child and comma lists`);
    this.name = 'UnsupportedSelectorError';
  }
}

const IDENT = /-?[_a-zA-Z -￿][-_a-zA-Z0-9 -￿]*/y;

function parseComplex(text: string, whole: string): Complex {
  let pos = 0;
  const fail = (reason: string): never => {
    throw new UnsupportedSelectorError(whole, reason);
  };
  const ident = (): string => {
    IDENT.lastIndex = pos;
    const m = IDENT.exec(text);
    if (!m) fail(`expected a name at "${text.slice(pos)}"`);
    pos = IDENT.lastIndex;
    return m![0];
  };
  const parts: { compound: Compound; combinator: ' ' | '>' | null }[] = [];
  let combinator: ' ' | '>' | null = null;
  for (;;) {
    const compound: Compound = { tag: null, id: null, classes: [], attrs: [] };
    let any = false;
    if (text[pos] === '*') {
      pos++;
      any = true;
    } else if (/[a-zA-Z]/.test(text[pos] ?? '')) {
      compound.tag = ident().toLowerCase();
      any = true;
    }
    for (;;) {
      const c = text[pos];
      if (c === '.') {
        pos++;
        compound.classes.push(ident());
      } else if (c === '#') {
        pos++;
        compound.id = ident();
      } else if (c === '[') {
        pos++;
        while (text[pos] === ' ') pos++;
        const name = ident().toLowerCase();
        while (text[pos] === ' ') pos++;
        let value: string | null = null;
        if (text[pos] === '=') {
          pos++;
          while (text[pos] === ' ') pos++;
          const q = text[pos];
          if (q === '"' || q === "'") {
            const end = text.indexOf(q, pos + 1);
            if (end === -1) fail('unclosed quote');
            value = text.slice(pos + 1, end);
            pos = end + 1;
          } else {
            value = ident();
          }
          while (text[pos] === ' ') pos++;
        } else if (text[pos] !== ']') {
          fail(`attribute operator "${text.slice(pos, pos + 2)}"`);
        }
        if (text[pos] !== ']') fail('attribute selector flags or a missing "]"');
        pos++;
        compound.attrs.push({ name, value });
      } else if (c === ':') {
        fail(`the pseudo-class "${/^::?[-\w]+/.exec(text.slice(pos))?.[0] ?? ':'}"`);
      } else {
        break;
      }
      any = true;
    }
    if (!any) fail(`unexpected "${text[pos] ?? 'end of selector'}"`);
    parts.push({ compound, combinator });
    if (pos >= text.length) break;
    let sawSpace = false;
    while (text[pos] === ' ') {
      pos++;
      sawSpace = true;
    }
    if (text[pos] === '>') {
      pos++;
      while (text[pos] === ' ') pos++;
      combinator = '>';
    } else if (text[pos] === '+' || text[pos] === '~') {
      fail(`the sibling combinator "${text[pos]}"`);
    } else if (sawSpace) {
      combinator = ' ';
    } else {
      fail(`unexpected "${text[pos]}"`);
    }
  }
  // Store right to left, with the combinator that leads leftwards from each compound.
  const out: Complex = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    out.push({ compound: parts[i]!.compound, combinator: i > 0 ? parts[i]!.combinator : null });
  }
  return out;
}

function splitList(selector: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let last = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(selector.slice(last, i));
      last = i + 1;
    }
  }
  out.push(selector.slice(last));
  return out.map((s) => s.trim().replace(/\s+/g, ' '));
}

const cache = new Map<string, Complex[]>();

/** Parse a selector list, or throw naming what the device does not support. */
function parseSelector(selector: string): Complex[] {
  const hit = cache.get(selector);
  if (hit) return hit;
  const list = splitList(selector);
  if (list.some((s) => s === '')) throw new UnsupportedSelectorError(selector, 'an empty selector');
  const parsed = list.map((s) => parseComplex(s, selector));
  if (cache.size > 256) cache.clear();
  cache.set(selector, parsed);
  return parsed;
}

function matchesCompound(el: LynxElement, c: Compound): boolean {
  if (c.tag !== null && el.tag.toLowerCase() !== c.tag) return false;
  if (c.id !== null && el.attrs.get('id') !== c.id) return false;
  if (c.classes.length) {
    const classes = (el.attrs.get('class') ?? '').split(/\s+/);
    if (!c.classes.every((k) => classes.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.attrs.get(a.name);
    if (v === undefined || (a.value !== null && v !== a.value)) return false;
  }
  return true;
}

function matchesComplex(el: LynxElement, complex: Complex): boolean {
  const [first, ...rest] = complex;
  if (!first || !matchesCompound(el, first.compound)) return false;
  return matchesFrom(el, rest, first.combinator);
}

/** Do the leftward compounds match, given how the previous one joins them? */
function matchesFrom(el: LynxElement, rest: Complex, combinator: ' ' | '>' | null): boolean {
  const [next, ...tail] = rest;
  if (!next) return true;
  if (combinator === '>') {
    const parent = el.parent;
    return !!parent && matchesCompound(parent, next.compound) && matchesFrom(parent, tail, next.combinator);
  }
  for (let a = el.parent; a; a = a.parent) {
    if (matchesCompound(a, next.compound) && matchesFrom(a, tail, next.combinator)) return true;
  }
  return false;
}

export function matches(el: LynxElement, selector: string): boolean {
  return parseSelector(selector).some((complex) => matchesComplex(el, complex));
}

export function closest(el: LynxElement, selector: string): LynxElement | null {
  const list = parseSelector(selector);
  for (let n: LynxElement | null = el; n; n = n.parent) {
    if (list.some((complex) => matchesComplex(n!, complex))) return n;
  }
  return null;
}

export function querySelectorAll(root: LynxElement, selector: string): LynxElement[] {
  const list = parseSelector(selector);
  const out: LynxElement[] = [];
  for (const el of descendants(root)) if (list.some((complex) => matchesComplex(el, complex))) out.push(el);
  return out;
}

export function querySelector(root: LynxElement, selector: string): LynxElement | null {
  const list = parseSelector(selector);
  for (const el of descendants(root)) if (list.some((complex) => matchesComplex(el, complex))) return el;
  return null;
}
