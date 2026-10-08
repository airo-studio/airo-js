/**
 * The JS node model: the HTML the server rendered, as elements and text,
 * kept alongside the Lynx element tree built from it.
 *
 * Hydrate code asks the DOM questions — which element has this data
 * attribute, what is the nearest ancestor matching this selector, is this
 * node inside that one — and needs the answers synchronously, before the
 * Lynx tree has been flushed to the screen. Element PAPI has no `closest`
 * or `contains`, and nothing guarantees its query sees unflushed elements.
 * So every question is answered here, from the model, and the Lynx tree is
 * a projection of it that `tree.ts` keeps in step.
 *
 * Nothing in this file calls Element PAPI.
 */

import type { ElementRef } from './papi.js';
import type { ParsedNode } from './tokenize.js';

/** What an element became on device. `none` is in the model only (a hidden input, a script). */
export type LynxKind = 'view' | 'scroll' | 'text' | 'image' | 'svg' | 'input' | 'textarea' | 'none';

export class LynxText {
  readonly kind = 'text' as const;
  parent: LynxElement | null = null;
  constructor(public data: string) {}
}

export class LynxElement {
  readonly kind = 'element' as const;
  parent: LynxElement | null = null;
  children: LynxNode[] = [];
  /** In source order. Names lowercase, except inside `<svg>`. */
  readonly attrs = new Map<string, string>();
  /** The Lynx element this node is projected as; null when not projected or `none`. */
  ref: ElementRef | null = null;
  /** What it was projected as, or null before projection. */
  as: LynxKind | null = null;
  /** Unique ids of every Lynx element this node owns (its own, and synthesised text wrappers). */
  uids: number[] = [];
  /** A form control's current value: the `value` attribute, then what the user typed. */
  value = '';
  /** The value when the control gained focus, for `change` on commit. */
  valueAtFocus: string | null = null;
  /**
   * Set once the user or a handler changed the value: `setAttribute('value')`
   * stops reaching it. On a `<select>`: its selection was set, so having no
   * option selected means none, not the first.
   */
  valueDirty = false;
  /** An `<option>`'s selectedness: from its `selected` attribute, then from picks (`./select.ts`). */
  selected = false;
  /** A `<dialog>` opened with `showModal()`, until it closes. */
  modal = false;

  constructor(
    readonly tag: string,
    /** True for `<svg>` and everything inside it. */
    readonly foreign: boolean,
  ) {}
}

export type LynxNode = LynxElement | LynxText;

/** Model nodes from parsed HTML. Values of form controls start from their markup. */
export function fromParsed(nodes: ParsedNode[]): LynxNode[] {
  return nodes.map((node) => {
    if (node.kind === 'text') return new LynxText(node.text);
    const el = new LynxElement(node.tag, node.foreign);
    for (const [name, value] of node.attrs) el.attrs.set(name, value);
    for (const child of fromParsed(node.children)) {
      child.parent = el;
      el.children.push(child);
    }
    if (el.tag === 'textarea') el.value = textContent(el);
    else if (el.tag === 'input') el.value = el.attrs.get('value') ?? '';
    else if (el.tag === 'option') el.selected = el.attrs.has('selected');
    return el;
  });
}

/** Every element below `el`, in tree order. */
export function* descendants(el: LynxElement): Generator<LynxElement> {
  for (const child of el.children) {
    if (child.kind === 'element') {
      yield child;
      yield* descendants(child);
    }
  }
}

export function contains(ancestor: LynxElement, node: LynxNode): boolean {
  for (let n: LynxNode | null = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

export function textContent(node: LynxNode): string {
  if (node.kind === 'text') return node.data;
  let out = '';
  for (const child of node.children) out += textContent(child);
  return out;
}

/** Attach `nodes` as children of `parent` at `index`, detaching them from wherever they were. */
export function insertChildren(parent: LynxElement, nodes: LynxNode[], index = parent.children.length): void {
  for (const node of nodes) detach(node);
  for (const node of nodes) node.parent = parent;
  parent.children.splice(index, 0, ...nodes);
}

function detach(node: LynxNode): void {
  const parent = node.parent;
  if (!parent) return;
  const i = parent.children.indexOf(node);
  if (i !== -1) parent.children.splice(i, 1);
  node.parent = null;
}

// ── serialisation ───────────────────────────────────────────────────────────

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** HTML for a node, as `outerHTML` would give it. */
export function serialize(node: LynxNode): string {
  if (node.kind === 'text') return node.parent && RAW.has(node.parent.tag) ? node.data : escapeText(node.data);
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  if (!node.foreign && VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  if (node.foreign && node.children.length === 0) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${serializeChildren(node)}</${node.tag}>`;
}

/** HTML for an element's children, as `innerHTML` would give it. */
export function serializeChildren(el: LynxElement): string {
  return el.children.map(serialize).join('');
}
