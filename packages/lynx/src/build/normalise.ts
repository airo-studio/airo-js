/**
 * The CSS normaliser: a cartridge's stylesheet in, a stylesheet the Lynx
 * encoder (engineVersion 3.9) reads the way a browser does, out. Plus a
 * report of everything it could not translate.
 *
 * Every rewrite here is mechanical and each one answers a measured gap:
 *
 * | rewrite | why |
 * |---|---|
 * | `html`, `body` → `.airo-lynx-page`, plus `font-size: 16px` on it | there is no `<body>`; `rem` follows the page element, whose default is 14px |
 * | type selectors → `.tag-<name>` | Lynx matches its own tags (`view`, `text`), never `h1` |
 * | `[n]` → `.a-n`, `[n="v"]` → `.a-n--v` | attribute selectors parse but never match; the runtime mirrors attributes into these classes |
 * | selectors the encoder rejects are split out of their list | the encoder drops the whole rule when one selector in its list fails to parse |
 * | `display: inline-flex` → `flex` | `inline-flex` falls back to Lynx's linear layout |
 * | `display: none` → plus `overflow: hidden` | Lynx lays a `display: none` box out at 0×0 but still paints the text inside it |
 * | the HTML UA rule `[hidden] { display: none }`, as `.a-hidden` | there is no UA stylesheet on device |
 * | `.airo-lynx-viewport` fills the page | the mount's scroller stands in for the viewport, which is the size of the screen |
 * | `font` shorthand → longhands | the encoder removes the shorthand |
 * | `inset` → `top` / `right` / `bottom` / `left` | the encoder removes the shorthand |
 * | `env(name, fallback)` → the fallback; a safe-area inset with none → `0px` | `env()` is not parsed, and takes the declaration (a `calc()` round it included) with it |
 * | static `calc()` in `:root` tokens and `border-radius` → its value | `calc()` in a radius reads as 0 |
 * | `aspect-ratio` with no width → plus `width: 100%` | Lynx applies `aspect-ratio` only to an explicit width |
 * | literal `oklch()` → sRGB | not parsed in a declaration (it is through a token) |
 * | `color-mix()` → sRGB, per theme | not parsed at all |
 * | `@media (prefers-color-scheme: …)` → the page's theme class | `@media` is dropped at engine 3.9 |
 *
 * **The headless rule.** The framework ships no visual policy, and this file
 * emits CSS the cartridge did not write. That is allowed only as browser
 * semantics: every declaration the normaliser *adds* is the value a browser
 * would have used for the same case (its UA stylesheet, a property's
 * initial value, or the used value of `auto`), and is recorded in
 * `report.emitted` with that citation. The tests hold the list to it.
 *
 * Colours are resolved against the `:root` tokens of each theme. Tokens are
 * read once, at build time, so a host that overrides a token at run time
 * will not see the baked `color-mix()` and radius values follow it.
 */

import * as csstree from 'css-tree';

import { attrClass, DARK_CLASS, PAGE_CLASS, tagClass, VIEWPORT_CLASS } from '../shared/attr-class.js';
import { formatSrgb, mixColours, parseColour } from './colour.js';
import { evalCalc, replaceCalls, resolveVars, splitTopLevel, type TokenTable, UnresolvableValueError } from './values.js';

type Plain = csstree.CssNodePlain;
type PlainRule = csstree.RulePlain;
type PlainDeclaration = csstree.DeclarationPlain;
type PlainSelector = csstree.SelectorPlain;

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** A declaration the normaliser added, with the browser behaviour it reproduces. */
export interface EmittedDeclaration {
  selector: string;
  property: string;
  value: string;
  cite: string;
  loc: SourceLocation | null;
}

export interface UnsupportedSelector {
  selector: string;
  reason: string;
  /** True when the normaliser took it out of its rule so the rest of the list survives. */
  removed: boolean;
  loc: SourceLocation | null;
}

export interface UnresolvedValue {
  property: string;
  value: string;
  reason: string;
  loc: SourceLocation | null;
}

export type RewriteKind =
  | 'page-selector'
  | 'type-selector'
  | 'attribute-selector'
  | 'rejected-selector-split'
  | 'inline-flex'
  | 'display-none-clip'
  | 'font-shorthand'
  | 'inset'
  | 'env'
  | 'calc'
  | 'aspect-ratio-width'
  | 'oklch'
  | 'color-mix'
  | 'color-scheme-media'
  | 'dark-variant';

export interface NormaliseReport {
  file: string;
  rewrites: Record<RewriteKind, number>;
  emitted: EmittedDeclaration[];
  unsupported: UnsupportedSelector[];
  droppedMedia: { query: string; loc: SourceLocation | null }[];
  unresolved: UnresolvedValue[];
}

export interface NormaliseResult {
  css: string;
  report: NormaliseReport;
}

export interface NormaliseOptions {
  /** Shown in errors and in the report. */
  filename?: string;
}

/** The stylesheet asks for something the build cannot compute; names the place. */
export class NormaliseError extends Error {
  constructor(
    message: string,
    readonly loc: SourceLocation | null,
  ) {
    super(loc ? `${loc.file}:${loc.line}:${loc.column}: ${message}` : message);
    this.name = 'NormaliseError';
  }
}

// ── what the encoder and the engine do with selectors (spike evidence) ──────

/** Pseudo-classes the encoder refuses outright, taking the whole selector list with them. */
const REJECTED_PSEUDO_CLASSES = new Set(['focus-visible', 'focus-within', 'has', 'is', 'where', 'invalid', 'valid']);

/**
 * Pseudo-elements the encoder parses; it rejects every other one. Lynx styles
 * an input's `::placeholder`; the rest parse without a measured effect.
 */
const PARSED_PSEUDO_ELEMENTS: ReadonlyMap<string, string | null> = new Map([
  ['placeholder', null],
  ['before', 'content does not render on device'],
  ['after', 'content does not render on device'],
  ['first-letter', 'is not verified on device'],
  ['first-line', 'is not verified on device'],
]);

/** Structural pseudo-classes that parse and never match. */
const NEVER_MATCHING_PSEUDO_CLASSES = new Set([
  'first-child',
  'last-child',
  'only-child',
  'nth-child',
  'nth-last-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'nth-of-type',
  'nth-last-of-type',
]);

/** Element names that only exist inside an `<svg>`: on device the SVG is one opaque element. */
const SVG_INTERNAL = new Set([
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'ellipse',
  'g',
  'use',
  'defs',
  'symbol',
  'tspan',
  'lineargradient',
  'radialgradient',
  'stop',
  'mask',
  'clippath',
]);

const CITE = {
  pageFontSize:
    'HTML UA stylesheet: the root element is `font-size: medium`, which is 16px in every browser (CSS Fonts 4 §2.5)',
  stretchWidth:
    'CSS 2.1 §10.3.3: a block with `width: auto` in normal flow fills its containing block; Lynx applies `aspect-ratio` only to an explicit width',
  fontReset: 'CSS Fonts 4 §2.8: the `font` shorthand resets every longhand it omits to its initial value',
  displayNone:
    'CSS Display 3 §2.5: `display: none` renders no descendants; Lynx lays the box out at 0×0 and still paints its text, which clipping to the box removes',
  hiddenUa: 'HTML §15.3.1 UA stylesheet: `[hidden] { display: none }`',
  viewport:
    'CSS 2.1 §10.1: the initial containing block has the dimensions of the viewport, which scrolls when the document overflows it; the scroller standing in for it fills the page',
} as const;

// ── helpers ─────────────────────────────────────────────────────────────────

const gen = (node: Plain): string => csstree.generate(csstree.fromPlainObject(structuredClone(node)));

function locOf(node: { loc?: csstree.CssLocation | null | undefined }, file: string): SourceLocation | null {
  const start = node.loc?.start;
  return start ? { file, line: start.line, column: start.column } : null;
}

const cls = (name: string): Plain => ({ type: 'ClassSelector', name }) as Plain;
const descendant = (): Plain => ({ type: 'Combinator', name: ' ' }) as Plain;
const notDark = (): Plain =>
  ({
    type: 'PseudoClassSelector',
    name: 'not',
    children: [{ type: 'SelectorList', children: [{ type: 'Selector', children: [cls(DARK_CLASS)] }] }],
  }) as Plain;

const decl = (property: string, value: string, important: PlainDeclaration['important'] = false): PlainDeclaration =>
  ({ type: 'Declaration', important, property, value: { type: 'Raw', value } }) as PlainDeclaration;

const valueText = (d: PlainDeclaration): string =>
  d.value.type === 'Raw' ? d.value.value.trim() : gen(d.value as Plain).trim();

const isRootNode = (n: Plain): boolean =>
  (n.type === 'PseudoClassSelector' && n.name === 'root') || (n.type === 'TypeSelector' && n.name === 'html');

/**
 * `:root` or `html` on its own, or (with `allowNot`) followed only by
 * `:not(…)`. A root selector with an attribute, like `:root[data-theme="dark"]`,
 * is not a token rule for either theme: no element carries that attribute on
 * device, so its declarations never apply there.
 */
function isRootCompound(selector: PlainSelector, allowNot: boolean): boolean {
  const [first, ...rest] = selector.children;
  return (
    first !== undefined &&
    isRootNode(first) &&
    rest.every((n) => allowNot && n.type === 'PseudoClassSelector' && n.name === 'not')
  );
}

/** `(prefers-color-scheme: dark)` → 'dark'; any other or compound query → null. */
function colourSchemeOf(query: string): 'dark' | 'light' | null {
  const m = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/i.exec(query.trim());
  return m ? (m[1]!.toLowerCase() as 'dark' | 'light') : null;
}

// ── tokens ──────────────────────────────────────────────────────────────────

/**
 * The custom properties each theme declares at the root. Light: top-level
 * `:root` / `html` rules. Dark: light, overlaid with the root rules inside
 * `@media (prefers-color-scheme: dark)` — the only dark mechanism that
 * reaches the device, where the page carries the theme class.
 */
function collectTokens(sheet: Plain[]): { light: Map<string, string>; dark: Map<string, string> } {
  const light = new Map<string, string>();
  const darkOverrides = new Map<string, string>();
  const take = (rule: PlainRule, into: Map<string, string>): void => {
    for (const d of rule.block.children) {
      if (d.type === 'Declaration' && d.property.startsWith('--')) into.set(d.property, valueText(d));
    }
  };
  for (const node of sheet) {
    if (node.type === 'Rule' && node.prelude.type === 'SelectorList') {
      if ((node.prelude.children as PlainSelector[]).every((s) => isRootCompound(s, false))) take(node, light);
    } else if (node.type === 'Atrule' && node.name.toLowerCase() === 'media' && node.prelude && node.block) {
      if (colourSchemeOf(gen(node.prelude as Plain)) !== 'dark') continue;
      for (const inner of node.block.children) {
        if (inner.type === 'Rule' && inner.prelude.type === 'SelectorList') {
          if ((inner.prelude.children as PlainSelector[]).every((s) => isRootCompound(s, true))) take(inner, darkOverrides);
        }
      }
    }
  }
  return { light, dark: new Map([...light, ...darkOverrides]) };
}

// ── the pass ────────────────────────────────────────────────────────────────

type Theme = 'both' | 'light' | 'dark';

interface Context {
  theme: Theme;
  inKeyframes: boolean;
}

class Normaliser {
  readonly report: NormaliseReport;
  private readonly tokens: { light: TokenTable; dark: TokenTable };

  constructor(
    private readonly file: string,
    sheet: Plain[],
  ) {
    this.tokens = collectTokens(sheet);
    this.report = {
      file,
      rewrites: {
        'page-selector': 0,
        'type-selector': 0,
        'attribute-selector': 0,
        'rejected-selector-split': 0,
        'inline-flex': 0,
        'display-none-clip': 0,
        'font-shorthand': 0,
        inset: 0,
        env: 0,
        calc: 0,
        'aspect-ratio-width': 0,
        oklch: 0,
        'color-mix': 0,
        'color-scheme-media': 0,
        'dark-variant': 0,
      },
      emitted: [],
      unsupported: [],
      droppedMedia: [],
      unresolved: [],
    };
  }

  private loc(node: { loc?: csstree.CssLocation | null | undefined }): SourceLocation | null {
    return locOf(node, this.file);
  }

  list(nodes: Plain[], ctx: Context): Plain[] {
    const out: Plain[] = [];
    for (const node of nodes) {
      if (node.type === 'Rule') {
        out.push(...this.rule(node, ctx));
        continue;
      }
      if (node.type !== 'Atrule' || !node.block) {
        out.push(node);
        continue;
      }
      const name = node.name.toLowerCase();
      if (name === 'media') {
        const query = node.prelude ? gen(node.prelude as Plain) : '';
        const scheme = colourSchemeOf(query);
        if (scheme) {
          this.report.rewrites['color-scheme-media']++;
          out.push(...this.list(node.block.children, { ...ctx, theme: scheme }));
          continue;
        }
        this.report.droppedMedia.push({ query, loc: this.loc(node) });
        node.block.children = this.list(node.block.children, ctx);
      } else if (name.endsWith('keyframes')) {
        node.block.children = this.list(node.block.children, { ...ctx, inKeyframes: true });
      } else if (name !== 'font-face') {
        node.block.children = this.list(node.block.children, ctx);
      }
      out.push(node);
    }
    return out;
  }

  private rule(rule: PlainRule, ctx: Context): Plain[] {
    if (rule.prelude.type !== 'SelectorList' || ctx.inKeyframes) {
      // Keyframe selectors are `from` / `to` / percentages, not elements; only their values change.
      const { dark } = this.declarations(rule, '', ctx);
      if (dark.length) this.report.unresolved.push({
        property: 'animation',
        value: gen(rule.prelude as Plain),
        reason: 'a keyframe colour depends on the theme; the light value was used',
        loc: this.loc(rule),
      });
      return [rule];
    }
    const kept: PlainSelector[] = [];
    const selectors = rule.prelude.children as PlainSelector[];
    for (const selector of selectors) {
      const original = gen(selector as Plain);
      const rejected = this.rewriteSelector(selector, original);
      if (rejected) {
        this.report.unsupported.push({ selector: original, reason: rejected, removed: true, loc: this.loc(selector) });
        continue;
      }
      kept.push(selector);
    }
    if (kept.length < selectors.length) this.report.rewrites['rejected-selector-split']++;
    if (kept.length === 0) return [];
    rule.prelude.children = kept.map((s) => this.themed(s, ctx.theme));

    const selectorText = gen(rule.prelude as Plain);
    const { dark } = this.declarations(rule, selectorText, ctx);
    if (!dark.length) return [rule];

    // The light value stays in place; a twin rule scoped to the dark page
    // class carries the dark one, the same shape as the author's own dark
    // token block once its media query has been rewritten.
    this.report.rewrites['dark-variant']++;
    const twin: PlainRule = {
      type: 'Rule',
      prelude: {
        type: 'SelectorList',
        children: kept.map((s) => this.themed(structuredClone(s), 'dark')),
      },
      block: { type: 'Block', children: dark },
    } as PlainRule;
    return [rule, twin];
  }

  /**
   * Rewrite one selector in place. Returns why it must be removed from its
   * rule (the encoder would reject the whole list), or null.
   */
  private rewriteSelector(selector: PlainSelector, original: string): string | null {
    let rejected: string | null = null;
    const warn = (reason: string): void => {
      this.report.unsupported.push({ selector: original, reason, removed: false, loc: this.loc(selector) });
    };
    const visit = (nodes: Plain[]): Plain[] =>
      nodes.map((node) => {
        switch (node.type) {
          case 'TypeSelector': {
            const name = node.name.toLowerCase();
            if (name === '*' || name.includes('|')) return node;
            if (name === 'html' || name === 'body') {
              this.report.rewrites['page-selector']++;
              return cls(PAGE_CLASS);
            }
            if (SVG_INTERNAL.has(name)) warn(`\`${name}\` is inside an inline SVG, which is one opaque element on device`);
            this.report.rewrites['type-selector']++;
            return cls(tagClass(name));
          }
          case 'AttributeSelector': {
            const name = node.name.name;
            const value = node.value ? (node.value.type === 'String' ? node.value.value : node.value.name) : null;
            if (node.flags) {
              warn(`attribute selector flag \`${node.flags}\` cannot be mirrored; never matches on device`);
              return node;
            }
            if (node.matcher === null) {
              this.report.rewrites['attribute-selector']++;
              return cls(attrClass(name));
            }
            if (node.matcher === '=' && value !== null) {
              const mirrored = attrClass(name, value);
              if (mirrored) {
                this.report.rewrites['attribute-selector']++;
                return cls(mirrored);
              }
              warn(`the value of [${name}] is too long or has whitespace, so it is not mirrored; never matches on device`);
              return node;
            }
            warn(`attribute operator \`${node.matcher}\` cannot be mirrored; never matches on device`);
            return node;
          }
          case 'PseudoElementSelector': {
            const name = node.name.toLowerCase();
            if (!PARSED_PSEUDO_ELEMENTS.has(name)) rejected ??= `::${name} is rejected by the Lynx encoder`;
            else if (PARSED_PSEUDO_ELEMENTS.get(name)) warn(`::${name} ${PARSED_PSEUDO_ELEMENTS.get(name)}`);
            return node;
          }
          case 'PseudoClassSelector': {
            const name = node.name.toLowerCase();
            if (REJECTED_PSEUDO_CLASSES.has(name)) rejected ??= `:${name} is rejected by the Lynx encoder`;
            else if (NEVER_MATCHING_PSEUDO_CLASSES.has(name)) warn(`:${name} parses but never matches on device`);
            else if (PARSED_PSEUDO_ELEMENTS.get(name)) warn(`:${name} ${PARSED_PSEUDO_ELEMENTS.get(name)}`);
            if (node.children && !rejected) {
              for (const child of node.children) {
                if (child.type === 'SelectorList') {
                  for (const inner of child.children) {
                    if (inner.type === 'Selector') inner.children = visit(inner.children);
                  }
                }
              }
            }
            return node;
          }
          default:
            return node;
        }
      });
    selector.children = visit(selector.children);
    return rejected;
  }

  /** Scope a selector to one theme by the page's class. 'both' leaves it alone. */
  private themed(selector: PlainSelector, theme: Theme): PlainSelector {
    if (theme === 'both') return selector;
    const nodes = selector.children;
    const firstCombinator = nodes.findIndex((n) => n.type === 'Combinator');
    const compound = firstCombinator === -1 ? nodes : nodes.slice(0, firstCombinator);
    const rootAt = compound.findIndex(
      (n) => (n.type === 'PseudoClassSelector' && n.name === 'root') || (n.type === 'ClassSelector' && n.name === PAGE_CLASS),
    );
    const marker = theme === 'dark' ? cls(DARK_CLASS) : notDark();
    if (rootAt === -1) {
      const prefix = theme === 'dark' ? [cls(DARK_CLASS)] : [cls(PAGE_CLASS), notDark()];
      selector.children = [...prefix, descendant(), ...nodes];
      return selector;
    }
    const rest = nodes.filter((n, i) => i !== rootAt && !(n.type === 'ClassSelector' && n.name === PAGE_CLASS));
    selector.children = [cls(PAGE_CLASS), marker, ...rest];
    return selector;
  }

  /**
   * Rewrite a rule's declarations in place. Returns the dark-theme values of
   * declarations whose colour differs by theme (only in a 'both' context).
   */
  private declarations(rule: PlainRule, selector: string, ctx: Context): { dark: PlainDeclaration[] } {
    const out: Plain[] = [];
    const dark: PlainDeclaration[] = [];
    const isTokenRule =
      rule.prelude.type === 'SelectorList' &&
      (rule.prelude.children as PlainSelector[]).every(
        (s) => s.children.every((n) => n.type !== 'Combinator') &&
          s.children.some(
            (n) => (n.type === 'PseudoClassSelector' && n.name === 'root') || (n.type === 'ClassSelector' && n.name === PAGE_CLASS),
          ),
      );
    const table = ctx.theme === 'dark' ? this.tokens.dark : this.tokens.light;

    for (const node of rule.block.children) {
      if (node.type !== 'Declaration') {
        out.push(node);
        continue;
      }
      const d = node as PlainDeclaration;
      const property = d.property.toLowerCase();
      let value = valueText(d);
      const loc = this.loc(d);

      if (/(^|[^\w-])env\(/i.test(value)) {
        let unknown = false;
        value = replaceCalls(value, 'env', (call) => {
          const [name, ...fallback] = splitTopLevel(call.inner, ',');
          if (fallback.length) return fallback.join(',').trim();
          // A browser with no inset there uses 0 (CSS Environment Variables §3).
          if (/^safe-area-inset-(top|right|bottom|left)$/i.test(name!.trim())) return '0px';
          unknown = true;
          return value.slice(call.start, call.end);
        });
        if (unknown) {
          this.report.unresolved.push({ property, value, reason: 'env() with no fallback and no known value; the encoder drops the declaration', loc });
        } else {
          this.report.rewrites.env++;
        }
      }

      if (property === 'inset') {
        const sides = this.expandInset(value, loc);
        if (sides) {
          this.report.rewrites.inset++;
          for (const [p, v] of sides) out.push(decl(p, v, d.important));
          continue;
        }
      }

      if (property === 'display' && /^inline-flex$/i.test(value)) {
        this.report.rewrites['inline-flex']++;
        value = 'flex';
      }

      if (property === 'font') {
        const longhands = this.expandFont(value, selector, loc);
        if (longhands) {
          this.report.rewrites['font-shorthand']++;
          for (const [p, v] of longhands) out.push(decl(p, v, d.important));
          continue;
        }
      }

      const isRadius = property.startsWith('border') && property.includes('radius');
      if ((isTokenRule && property.startsWith('--')) || isRadius) {
        // Each calc() on its own: `border-radius: calc(…) calc(…) 0 0` has four values.
        let unresolved = false;
        const next = replaceCalls(value, 'calc', (call) => {
          const text = value.slice(call.start, call.end);
          const result = evalCalc(text, table);
          if (result === null) unresolved = true;
          return result ?? text;
        });
        if (next !== value) this.report.rewrites.calc++;
        if (unresolved) {
          this.report.unresolved.push({
            property,
            value,
            reason: 'calc() is not static (%, em, viewport units or env()); a radius reads it as 0 on device',
            loc,
          });
        }
        value = next;
      }

      const custom = property.startsWith('--');
      const hasMix = /color-mix\(/i.test(value);
      const hasOklch = !custom && /(^|[^\w-])oklch\(/i.test(value);
      if (hasMix || hasOklch) {
        const lightValue = this.lowerColours(value, table, loc);
        if (ctx.theme === 'both' && /var\(/i.test(value)) {
          const darkValue = this.lowerColours(value, this.tokens.dark, loc);
          if (darkValue !== lightValue) dark.push(decl(d.property, darkValue, d.important));
        }
        if (hasMix) this.report.rewrites['color-mix']++;
        if (hasOklch) this.report.rewrites.oklch++;
        value = lightValue;
      }

      out.push(decl(d.property, value, d.important));
    }

    const props = new Set(out.flatMap((n) => (n.type === 'Declaration' ? [n.property.toLowerCase()] : [])));
    const none = out.find(
      (n): n is PlainDeclaration => n.type === 'Declaration' && n.property.toLowerCase() === 'display' && /^none$/i.test(valueText(n)),
    );
    if (none && !props.has('overflow') && !ctx.inKeyframes) {
      // Same importance as the display, so it wins and loses where display does.
      this.report.rewrites['display-none-clip']++;
      out.push(decl('overflow', 'hidden', none.important));
      this.report.emitted.push({ selector, property: 'overflow', value: 'hidden', cite: CITE.displayNone, loc: this.loc(none) });
    }
    const sized = ['width', 'height', 'inline-size', 'block-size'].some((p) => props.has(p));
    if (props.has('aspect-ratio') && !sized && !ctx.inKeyframes) {
      this.report.rewrites['aspect-ratio-width']++;
      out.push(decl('width', '100%'));
      this.report.emitted.push({ selector, property: 'width', value: '100%', cite: CITE.stretchWidth, loc: this.loc(rule) });
    }

    rule.block.children = out;
    return { dark };
  }

  /** `color-mix()` and literal `oklch()` → sRGB, with tokens from one theme. */
  private lowerColours(value: string, tokens: TokenTable, loc: SourceLocation | null): string {
    const evalColour = (text: string): ReturnType<typeof parseColour> => {
      const resolved = resolveVars(text, tokens).trim();
      if (/^color-mix\(/i.test(resolved)) return mixColours(resolved.slice(resolved.indexOf('(') + 1, -1), evalColour);
      return parseColour(resolved);
    };
    try {
      const mixed = replaceCalls(value, 'color-mix', (call) => formatSrgb(mixColours(call.inner, evalColour)));
      return replaceCalls(mixed, 'oklch', (call) => formatSrgb(evalColour(mixed.slice(call.start, call.end))));
    } catch (err) {
      if (err instanceof UnresolvableValueError) throw new NormaliseError(`cannot lower "${value}": ${err.message}`, loc);
      throw err;
    }
  }

  /** `inset: a b c d` → the four sides, as any box shorthand. Null (and reported) when a `var()` hides how many values there are. */
  private expandInset(value: string, loc: SourceLocation | null): [string, string][] | null {
    const parts = splitTopLevel(value, ' ');
    if (parts.some((p) => /var\(/i.test(p)) || parts.length < 1 || parts.length > 4) {
      this.report.unresolved.push({ property: 'inset', value, reason: 'a var() hides how many sides it sets; the encoder will remove it', loc });
      return null;
    }
    const [top, right = top, bottom = top, left = right] = parts as [string, string?, string?, string?];
    return [
      ['top', top],
      ['right', right!],
      ['bottom', bottom!],
      ['left', left!],
    ];
  }

  /**
   * `font: 600 1rem/1.4 var(--font-sans)` → longhands. Returns null (and
   * reports) when the shorthand cannot be split at build time.
   */
  private expandFont(value: string, selector: string, loc: SourceLocation | null): [string, string][] | null {
    if (/^(inherit|initial|unset|revert|revert-layer)$/i.test(value)) {
      return ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'].map((p) => [p, value]);
    }
    const words = splitTopLevel(value.replace(/\s*\/\s*/g, '/'), ' ');
    let style: string | null = null;
    let weight: string | null = null;
    let variant: string | null = null;
    let i = 0;
    for (; i < words.length; i++) {
      const w = words[i]!;
      if (/^(italic|oblique)$/i.test(w)) style = w;
      else if (/^small-caps$/i.test(w)) variant = w;
      else if (/^(bold|bolder|lighter|\d{1,4})$/i.test(w)) weight = w;
      else if (/^normal$/i.test(w)) continue;
      else break;
    }
    const sizeWord = words[i];
    const family = words.slice(i + 1).join(' ');
    if (!sizeWord || !family || /var\(/i.test(sizeWord) || !/^([\d.]+[a-z%]*|calc\(.*\)|(xx?-)?(small|large)|xxx-large|medium|smaller|larger)(\/.+)?$/i.test(sizeWord)) {
      this.report.unresolved.push({
        property: 'font',
        value,
        reason: 'the shorthand cannot be split at build time (a var() or system font); the encoder will remove it',
        loc,
      });
      return null;
    }
    const [size, lineHeight] = sizeWord.split('/') as [string, string | undefined];
    const out: [string, string][] = [
      ['font-style', style ?? 'normal'],
      ['font-weight', weight ?? 'normal'],
      ['font-size', size],
      ['line-height', lineHeight ?? 'normal'],
      ['font-family', family],
    ];
    if (variant) out.push(['font-variant', variant]);
    const reset = (p: string, v: string): void => {
      this.report.emitted.push({ selector, property: p, value: v, cite: CITE.fontReset, loc });
    };
    if (style === null) reset('font-style', 'normal');
    if (weight === null) reset('font-weight', 'normal');
    if (lineHeight === undefined) reset('line-height', 'normal');
    return out;
  }
}

/**
 * Normalise one stylesheet for the Lynx encoder. Throws `NormaliseError`
 * (with file, line and column) when a colour depends on something the build
 * cannot see, such as a custom property that is not a `:root` token.
 */
export function normaliseCss(css: string, options: NormaliseOptions = {}): NormaliseResult {
  const file = options.filename ?? 'stylesheet.css';
  const ast = csstree.parse(css, {
    positions: true,
    filename: file,
    parseValue: false,
    parseCustomProperty: false,
    onParseError(error) {
      throw new NormaliseError(`unparseable CSS: ${error.message}`, null);
    },
  });
  const plain = csstree.toPlainObject(ast) as csstree.StyleSheetPlain;
  const normaliser = new Normaliser(file, plain.children);
  const children = normaliser.list(plain.children, { theme: 'both', inKeyframes: false });

  // The browser's own defaults the device lacks, first so every author rule wins over them.
  const hidden = `.${attrClass('hidden')}`;
  const viewport = `.${VIEWPORT_CLASS}`;
  const pageRule = csstree.toPlainObject(
    csstree.parse(`.${PAGE_CLASS}{font-size:16px}${viewport}{width:100%;height:100%}${hidden}{display:none;overflow:hidden}`),
  ) as csstree.StyleSheetPlain;
  normaliser.report.emitted.unshift(
    { selector: `.${PAGE_CLASS}`, property: 'font-size', value: '16px', cite: CITE.pageFontSize, loc: null },
    { selector: viewport, property: 'width', value: '100%', cite: CITE.viewport, loc: null },
    { selector: viewport, property: 'height', value: '100%', cite: CITE.viewport, loc: null },
    { selector: hidden, property: 'display', value: 'none', cite: CITE.hiddenUa, loc: null },
    { selector: hidden, property: 'overflow', value: 'hidden', cite: CITE.displayNone, loc: null },
  );
  plain.children = [...pageRule.children, ...children];

  return { css: csstree.generate(csstree.fromPlainObject(plain)), report: normaliser.report };
}
