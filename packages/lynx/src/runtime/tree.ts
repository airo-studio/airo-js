/**
 * The tree pass: model elements → Lynx elements, and keeping the two in step.
 *
 * ## Mapping
 *
 * | HTML | Lynx |
 * |---|---|
 * | text-level tags (`p`, `h1`–`h6`, `li`, `span`, …) whose content is text and inline tags | `text`, inline children as nested `text` |
 * | other containers, and `a` / `button` outside running text | `view`; each text run inside becomes a synthesised `text` |
 * | `img` | `image` (`src` resolved against the page's base url; with no size of its own it takes the picture's); an SVG source is an `svg` with that `src`, since `image` does not draw SVG |
 * | `svg` | `svg` with `content` set to the element's own markup |
 * | `input` (text-like types), `textarea` | `input`, `textarea`; value from the markup, then from typing |
 * | `input type="checkbox"`, `"radio"` | an empty `view` the stylesheet draws; checked, it carries `.airo-lynx-checked`. A tap on it or its `<label>` toggles it |
 * | `input type="file"` | an empty `view` the stylesheet draws; a tap on it or its `<label>` asks the host's `onPick` for files |
 * | `details`, `summary` | `view`s (a summary of text and inline tags is a `text`); a closed `details` shows its first `summary` only, and a tap on that summary toggles `open` |
 * | `dialog` | a `view`, empty and hidden while closed; opened with `showModal()`, it sits inside a `view` that is its backdrop |
 * | `select` | a `view` holding the selected option's label; a tap asks the host's `onPick` for a choice (`./select.ts`). `multiple` and `size` > 1 are refused |
 * | `input type="hidden"`, `script`, `template`, `noscript`, `option`, `optgroup` | nothing on screen; in the model only |
 * | the mount's root (the element the server rendered into) | a vertical `scroll-view`: the browser viewport scrolls, a Lynx `view` does not |
 * | anything else | refused by name (`UnmappedElementError`) |
 *
 * Every element also carries `tag-<name>` and one class per attribute
 * (`./shared/attr-class.ts`), which is what the normalised stylesheet's type
 * and attribute selectors were rewritten to.
 *
 * ## Keeping in step
 *
 * The model is the source of truth. A change to an element's content
 * re-projects the smallest subtree that contains it: the element itself, or
 * the outermost `text` around it when it sits inside running text, since a
 * `text` cannot hold a `view`. Attribute writes update classes and
 * attributes in place. Every change marks the tree dirty, and one microtask
 * later the tree is flushed once — so a handler that writes a hundred
 * times costs one flush, and the writes show up before the next frame.
 */

import {
  attrClass,
  BACKDROP_CLASS,
  backdropClass,
  CHECKED_CLASS,
  CLOSED_DIALOG_CLASS,
  DARK_CLASS,
  EMPTY_CLASS,
  MODAL_CLASS,
  PAGE_CLASS,
  tagClass,
  UNMIRRORED_ATTRIBUTES,
  VIEWPORT_CLASS,
} from '../shared/attr-class.js';
import { LynxRefusalError, log, UnmappedElementError } from './errors.js';
import { isCheckable, type LynxElement, type LynxKind, type LynxNode, serialize } from './node-model.js';
import type { ElementRef, NativeEvent, NativeListener, Papi } from './papi.js';
import { optionLabel, selectedOption, selectOf } from './select.js';

/** Becomes `text` when its content is only text and inline tags. */
const TEXT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd', 'figcaption', 'legend', 'blockquote', 'address',
  'label', 'span', 'strong', 'em', 'b', 'i', 'small', 'time', 'mark', 'abbr', 'code', 'cite', 'q', 's', 'u',
  'sub', 'sup', 'kbd', 'data', 'var', 'samp', 'del', 'ins', 'bdi', 'bdo', 'summary',
]);

/** Can sit inside running text as a nested `text`. */
const INLINE_TAGS = new Set([
  'span', 'a', 'strong', 'em', 'b', 'i', 'small', 'time', 'mark', 'abbr', 'code', 'cite', 'q', 's', 'u',
  'sub', 'sup', 'kbd', 'data', 'var', 'samp', 'del', 'ins', 'bdi', 'bdo', 'label', 'br', 'button',
]);

/** Containers that are always a `view`, whatever they hold. */
const VIEW_TAGS = new Set([
  'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'form', 'ol', 'ul',
  'dl', 'fieldset', 'hgroup', 'search', 'menu', 'hr', 'a', 'button', 'details', 'dialog',
]);

/** In the model, never on screen. */
const MODEL_ONLY = new Set(['script', 'template', 'noscript', 'option', 'optgroup']);

/** HTML input types the Lynx `input` element can stand in for, and the type it gets. */
const INPUT_TYPES: Record<string, string> = {
  text: 'text',
  search: 'text',
  url: 'text',
  email: 'email',
  tel: 'tel',
  password: 'password',
  number: 'number',
};

/** Lynx events a form control is listened on for, from projection until it is replaced. */
export type ControlEvent = 'input' | 'focus' | 'blur' | 'confirm';
const CONTROL_EVENTS: readonly ControlEvent[] = ['input', 'focus', 'blur', 'confirm'];

/** Every class an element's attributes stand for: presence, and value when it is a short token. */
export function mirrorClasses(attrs: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [name, value] of attrs) {
    if (UNMIRRORED_ATTRIBUTES.has(name)) continue;
    out.push(attrClass(name));
    const valued = attrClass(name, value);
    if (valued) out.push(valued);
  }
  return out;
}

function classString(el: LynxElement): string {
  const authored = (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  const own = el.as === 'scroll' ? [VIEWPORT_CLASS] : [];
  if (el.children.length === 0) own.push(EMPTY_CLASS);
  if (el.checked && isCheckable(el)) own.push(CHECKED_CLASS);
  if (el.tag === 'dialog' && !el.attrs.has('open')) own.push(CLOSED_DIALOG_CLASS);
  else if (el.modal) own.push(MODAL_CLASS);
  return [...own, ...authored, tagClass(el.tag), ...mirrorClasses(el.attrs)].join(' ');
}

/** An `<img>` source that is an SVG: a `.svg` path, or an `image/svg+xml` data url. */
const isSvgSource = (src: string): boolean => /\.svg(?:[?#]|$)/i.test(src) || /^data:image\/svg\+xml[;,]/i.test(src);

/** `w / h` from an img's `width` and `height` attributes, when both are positive numbers. */
function attributeRatio(el: LynxElement): string | null {
  const w = Number.parseFloat(el.attrs.get('width') ?? '');
  const h = Number.parseFloat(el.attrs.get('height') ?? '');
  return w > 0 && h > 0 ? `${w} / ${h}` : null;
}

/** A modal's backdrop: its own class, and one per class of its dialog, which `X::backdrop` rules were rewritten to. */
const backdropClasses = (dialog: LynxElement): string =>
  [BACKDROP_CLASS, ...classString(dialog).split(' ').map(backdropClass)].join(' ');

/** The children a browser renders: all, except in a closed `<details>` (its first summary) and a closed `<dialog>` (none). */
function renderedChildren(el: LynxElement): readonly LynxNode[] {
  if (el.tag === 'details' && !el.attrs.has('open')) {
    const summary = el.children.find((c) => c.kind === 'element' && c.tag === 'summary');
    return summary ? [summary] : [];
  }
  if (el.tag === 'dialog' && !el.attrs.has('open')) return [];
  return el.children;
}

const collapse = (s: string): string => s.replace(/[ \t\n\f\r]+/g, ' ');

function isTextOnly(el: LynxElement): boolean {
  return el.children.every(
    (c) => c.kind === 'text' || MODEL_ONLY.has(c.tag) || (INLINE_TAGS.has(c.tag) && !c.foreign && isTextOnly(c)),
  );
}

export interface TreeOptions {
  papi: Papi;
  /** Unique id of the page element; every element is created under it. */
  pid: number;
  /** Origin and path relative `src` values resolve against. */
  baseUrl?: string;
  /** Called for the native events of every form control. */
  onControlEvent: (el: LynxElement, event: ControlEvent, native: NativeEvent) => void;
}

export class NativeTree {
  readonly papi: Papi;
  readonly pid: number;
  /** Lynx unique id → the model element it stands for (text wrappers map to their element). */
  readonly byUid = new Map<number, LynxElement>();
  /** How many times the tree has been flushed. */
  flushes = 0;
  private dirty = false;
  private afterFlush: (() => void)[] = [];
  /** Projected `svg` elements, and the colour last handed to each as `current-color`. */
  private readonly svgs = new Map<LynxElement, string | null>();
  /** Images not laid out yet: each is pinned or given `auto-size` once it is (`syncImages`). */
  private readonly unmeasuredImages = new Set<LynxElement>();
  /** Images the stylesheet sizes, with the ratio they were laid out at: their height is set inline. */
  private readonly pinnedImages = new Map<LynxElement, { ratio: number; width: number }>();
  /** Images the stylesheet leaves unsized: built with `auto-size`, which Lynx reads only at creation. */
  private readonly autoSizedImages = new Set<LynxElement>();
  /** Each modal dialog on screen, and the backdrop it is drawn inside: what stands in its parent's place. */
  private readonly backdrops = new Map<LynxElement, ElementRef>();

  constructor(private readonly opts: TreeOptions) {
    this.papi = opts.papi;
    this.pid = opts.pid;
  }

  /** The mount's root, projected as the scrolling viewport. */
  viewport: LynxElement | null = null;

  /** The Lynx kind `el` projects as, in a block (`view`) parent. Throws for an unmapped tag. */
  kindOf(el: LynxElement): LynxKind {
    if (el === this.viewport) return 'scroll';
    if (el.foreign) {
      if (el.tag.toLowerCase() === 'svg') return 'svg';
      throw new UnmappedElementError(el.tag);
    }
    switch (el.tag) {
      case 'img':
        return isSvgSource(el.attrs.get('src') ?? '') ? 'svg' : 'image';
      case 'textarea':
        return 'textarea';
      case 'input': {
        const type = (el.attrs.get('type') ?? 'text').toLowerCase();
        if (type === 'hidden') return 'none';
        if (INPUT_TYPES[type]) return 'input';
        // No native checkbox or file picker: an empty view the stylesheet draws.
        if (type === 'checkbox' || type === 'radio' || type === 'file') return 'view';
        throw new UnmappedElementError(`input type="${type}"`);
      }
      case 'select':
        if (el.attrs.has('multiple')) throw new UnmappedElementError('select multiple');
        if (Number(el.attrs.get('size') ?? 1) > 1) throw new UnmappedElementError(`select size="${el.attrs.get('size')}"`);
        return 'view';
      default:
        if (MODEL_ONLY.has(el.tag)) return 'none';
        if (TEXT_TAGS.has(el.tag) && !VIEW_TAGS.has(el.tag) && isTextOnly(el)) return 'text';
        if (TEXT_TAGS.has(el.tag) || VIEW_TAGS.has(el.tag)) return 'view';
        if (el.tag === 'br') return 'none';
        throw new UnmappedElementError(el.tag);
    }
  }

  /**
   * Check that every element under `nodes` has a mapping, before anything
   * is changed. A tree that cannot be projected throws here, with the model
   * and the screen untouched.
   */
  validate(nodes: readonly LynxNode[]): void {
    for (const node of nodes) {
      if (node.kind !== 'element') continue;
      if (node.foreign) {
        // An svg's insides travel as its `content` string; only the root needs a mapping.
        if (node.tag.toLowerCase() !== 'svg') throw new UnmappedElementError(node.tag);
        continue;
      }
      const t = node.tag;
      if (!TEXT_TAGS.has(t) && !VIEW_TAGS.has(t) && !INLINE_TAGS.has(t)) this.kindOf(node);
      this.validate(node.children);
    }
  }

  // ── projection ────────────────────────────────────────────────────────────

  private own(el: LynxElement, ref: ElementRef): void {
    const uid = this.papi.uniqueId(ref);
    el.uids.push(uid);
    this.byUid.set(uid, el);
  }

  private forget(el: LynxElement): void {
    this.svgs.delete(el);
    this.backdrops.delete(el);
    this.unmeasuredImages.delete(el);
    this.pinnedImages.delete(el);
    for (const uid of el.uids) if (this.byUid.get(uid) === el) this.byUid.delete(uid);
    el.uids = [];
    el.ref = null;
    el.as = null;
    for (const child of el.children) if (child.kind === 'element') this.forget(child);
  }

  private applyAttributes(el: LynxElement): void {
    const ref = el.ref!;
    this.papi.setClasses(ref, classString(el));
    const id = el.attrs.get('id');
    if (id !== undefined) this.papi.setId(ref, id);
    const backdrop = this.backdrops.get(el);
    if (backdrop) this.papi.setClasses(backdrop, backdropClasses(el));
    switch (el.as) {
      case 'image': {
        this.papi.setAttribute(ref, 'src', this.resolve(el.attrs.get('src') ?? ''));
        this.papi.setAttribute(ref, 'mode', 'scaleToFill');
        // A size the stylesheet leaves open comes from the picture, as in a
        // browser; without `auto-size` Lynx draws the image 0 wide or 0 tall.
        // But `auto-size` on an image the stylesheet does size hands a grid
        // the picture's natural size (a row 768 tall around a 263-tall photo,
        // measured), so which it is waits for the first layout (`syncImages`).
        // With no computed style to read, always.
        if (this.autoSizedImages.has(el) || !this.papi.computedStyle) this.papi.setAttribute(ref, 'auto-size', true);
        else if (!this.pinnedImages.has(el)) this.unmeasuredImages.add(el);
        const alt = el.attrs.get('alt');
        if (alt) this.papi.setAttribute(ref, 'accessibility-label', alt);
        break;
      }
      case 'svg':
        if (el.tag === 'img') {
          // An SVG drawn as an image: no currentColor from the page, as in a browser.
          this.papi.setAttribute(ref, 'src', this.resolve(el.attrs.get('src') ?? ''));
          const alt = el.attrs.get('alt');
          if (alt) this.papi.setAttribute(ref, 'accessibility-label', alt);
          // A browser maps an img's width and height attributes to
          // `aspect-ratio`, so a stylesheet that sets one side gets the other.
          // Lynx's svg has no picture size to fall back on (an image's
          // auto-size), so the ratio is set here, inline: it beats an author
          // `aspect-ratio` on the same img, where a browser's would lose.
          const ratio = attributeRatio(el);
          this.papi.setInlineStyles(ref, ratio ? `aspect-ratio: ${ratio}` : '');
          break;
        }
        this.papi.setAttribute(ref, 'content', serialize(el));
        this.svgs.set(el, null);
        break;
      case 'scroll':
        this.papi.setAttribute(ref, 'scroll-orientation', 'vertical');
        break;
      case 'input':
      case 'textarea': {
        if (el.as === 'input') {
          this.papi.setAttribute(ref, 'type', INPUT_TYPES[(el.attrs.get('type') ?? 'text').toLowerCase()] ?? 'text');
        }
        const placeholder = el.attrs.get('placeholder');
        if (placeholder !== undefined) this.papi.setAttribute(ref, 'placeholder', placeholder);
        const maxlength = el.attrs.get('maxlength');
        if (maxlength !== undefined) this.papi.setAttribute(ref, 'maxlength', Number(maxlength));
        this.papi.setAttribute(ref, 'disabled', el.attrs.has('disabled'));
        this.papi.setAttribute(ref, 'readonly', el.attrs.has('readonly'));
        this.papi.setAttribute(ref, 'default-value', el.value);
        break;
      }
      default:
        break;
    }
  }

  /** A `text` holding one run of text: what a view's loose text becomes. */
  private wrapText(owner: LynxElement, text: string): ElementRef {
    const wrapper = this.papi.createText(this.pid);
    this.own(owner, wrapper);
    this.papi.append(wrapper, this.papi.createRawText(text));
    return wrapper;
  }

  /** Inline content of a `text` element: raw text and nested `text` for inline tags. */
  private projectInline(el: LynxElement, into: ElementRef, edges: { first: boolean; last: boolean }): void {
    const n = el.children.length;
    el.children.forEach((child, i) => {
      if (child.kind === 'text') {
        let text = collapse(child.data);
        if (edges.first && i === 0) text = text.replace(/^ /, '');
        if (edges.last && i === n - 1) text = text.replace(/ $/, '');
        if (text) this.papi.append(into, this.papi.createRawText(text));
        return;
      }
      if (MODEL_ONLY.has(child.tag)) {
        child.as = 'none';
        return;
      }
      if (child.tag === 'br') {
        child.as = 'none';
        this.papi.append(into, this.papi.createRawText('\n'));
        return;
      }
      const nested = this.papi.createText(this.pid);
      child.ref = nested;
      child.as = 'text';
      this.own(child, nested);
      this.applyAttributes(child);
      this.projectInline(child, nested, {
        first: edges.first && i === 0,
        last: edges.last && i === n - 1,
      });
      this.papi.append(into, nested);
    });
  }

  private create(kind: Exclude<LynxKind, 'none'>): ElementRef {
    switch (kind) {
      case 'view':
        return this.papi.createView(this.pid);
      case 'scroll':
        return this.papi.createScrollView(this.pid);
      case 'text':
        return this.papi.createText(this.pid);
      case 'image':
        return this.papi.createImage(this.pid);
      default:
        return this.papi.createElement(kind, this.pid);
    }
  }

  /**
   * Build the Lynx element for `el` (and below) in a block parent. Returns
   * what goes in the parent: null for `none`, and a modal dialog's backdrop
   * with the dialog inside it.
   */
  project(el: LynxElement): ElementRef | null {
    const kind = this.kindOf(el);
    el.as = kind;
    el.uids = [];
    if (kind === 'none') {
      el.ref = null;
      for (const child of el.children) if (child.kind === 'element') child.as = 'none';
      return null;
    }
    const p = this.papi;
    const ref = this.create(kind);
    el.ref = ref;
    this.own(el, ref);
    this.applyAttributes(el);

    if (kind === 'text') {
      this.projectInline(el, ref, { first: true, last: true });
    } else if (el.tag === 'select') {
      const selected = selectedOption(el);
      const label = selected ? optionLabel(selected) : '';
      if (label) p.append(ref, this.wrapText(el, label));
    } else if (kind === 'view' || kind === 'scroll') {
      for (const child of renderedChildren(el)) {
        if (child.kind === 'text') {
          const text = collapse(child.data).trim();
          if (text) p.append(ref, this.wrapText(el, text));
          continue;
        }
        const childRef = this.project(child);
        if (childRef) p.append(ref, childRef);
      }
    } else if (kind === 'input' || kind === 'textarea') {
      for (const event of CONTROL_EVENTS) {
        const listener: NativeListener = (native) => this.opts.onControlEvent(el, event, native);
        p.addEventListener(ref, event, listener);
      }
    }
    if (el.modal && el.attrs.has('open')) {
      // The browser draws a modal over a ::backdrop box that covers the
      // viewport. Here that box is an element, and the dialog sits inside
      // it, where its parent's styles still reach it by inheritance. A tap
      // on it is a tap on the dialog, as a click on the backdrop is.
      const backdrop = p.createView(this.pid);
      this.own(el, backdrop);
      this.backdrops.set(el, backdrop);
      p.setClasses(backdrop, backdropClasses(el));
      p.append(backdrop, ref);
      return backdrop;
    }
    return ref;
  }

  // ── keeping in step ───────────────────────────────────────────────────────

  /**
   * Rebuild the Lynx subtree for `el` after its content changed. Climbs to
   * the outermost `text` around an inline element, and to the parent when
   * `el` was not on screen before (its position among siblings is only
   * known there).
   */
  reproject(el: LynxElement): void {
    let target = el;
    while (target.parent && target.parent.as === 'text') target = target.parent;
    if (!target.ref && target.parent && target.parent.ref) target = target.parent;
    const previous = target.ref && (this.backdrops.get(target) ?? target.ref);
    if (!previous) {
      // Not on screen, and no projected parent to rebuild from: the model
      // changed, and there is nothing to show yet.
      return;
    }
    const parentRef = target.parent?.ref ?? null;
    this.forget(target);
    const next = this.project(target);
    if (next) this.papi.replace(next, previous);
    else if (parentRef) this.papi.remove(parentRef, previous);
    this.markDirty();
  }

  /** Classes and Lynx attributes after `el`'s attributes changed. */
  refreshAttributes(el: LynxElement, changed: string): void {
    if (el.foreign) {
      let svg: LynxElement = el;
      while (svg.parent?.foreign) svg = svg.parent;
      if (svg.ref) {
        this.papi.setAttribute(svg.ref, 'content', serialize(svg));
        this.markDirty();
      }
      return;
    }
    if (
      (el.tag === 'input' && changed === 'type') ||
      (el.tag === 'img' && changed === 'src' && el.as !== null && this.kindOf(el) !== el.as) ||
      ((el.tag === 'details' || el.tag === 'dialog') && changed === 'open')
    ) {
      this.reproject(el);
      return;
    }
    if (el.tag === 'option') {
      // Not on screen itself: what it changes is its select's label.
      const select = selectOf(el);
      if (select && (changed === 'selected' || changed === 'label' || changed === 'disabled')) this.reproject(select);
      return;
    }
    this.restyle(el);
  }

  /**
   * Classes again after an attribute or state the stylesheet reads as a
   * class changed (`:checked`). Lynx matches `+` and `~` on first paint but
   * does not restyle a following sibling when an element's classes change
   * (measured: `input:checked + .track` stayed grey), so every following
   * sibling's classes are set again too.
   */
  restyle(el: LynxElement): void {
    if (!el.ref) return;
    this.applyAttributes(el);
    const siblings = el.parent?.children ?? [];
    for (let i = siblings.indexOf(el) + 1; i < siblings.length; i++) {
      const next = siblings[i]!;
      if (next.kind === 'element' && next.ref) this.papi.setClasses(next.ref, classString(next));
    }
    this.markDirty();
  }

  /** Set a control's value on screen. Runs after the next flush, when the element exists natively. */
  pushValue(el: LynxElement): void {
    this.markDirty(() => {
      if (el.ref && (el.as === 'input' || el.as === 'textarea')) {
        this.papi.invokeUIMethod(el.ref, 'setValue', { value: el.value });
      }
    });
  }

  /** The page element's classes: the page class, and the dark class when dark. */
  setPageTheme(page: ElementRef, scheme: 'light' | 'dark'): void {
    this.papi.setClasses(page, scheme === 'dark' ? `${PAGE_CLASS} ${DARK_CLASS}` : PAGE_CLASS);
    this.markDirty();
  }

  // ── flushing ──────────────────────────────────────────────────────────────

  /** Schedule one flush for this task; `then` runs right after it. */
  markDirty(then?: () => void): void {
    if (then) this.afterFlush.push(then);
    if (this.dirty) return;
    this.dirty = true;
    Promise.resolve().then(() => this.flushNow());
  }

  /** Flush now if anything changed. Idempotent within a task. */
  flushNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.papi.flush();
    this.flushes++;
    // A second flush only when an icon's colour changed, which is rare after the first paint.
    if (this.syncImages() || this.syncSvgColours()) {
      this.papi.flush();
      this.flushes++;
    }
    const after = this.afterFlush;
    this.afterFlush = [];
    for (const fn of after) {
      try {
        fn();
      } catch (err) {
        log.error('[@airo-js/lynx] post-flush update failed', err);
      }
    }
  }

  /**
   * After a layout, settle each image's size the way a browser would have:
   *
   *   - **Sized by the stylesheet** (laid out with a width and a height): its
   *     height is set inline, at the height it was laid out at, and follows
   *     its width afterwards. Lynx's grid sizes an auto row as 0 when its
   *     content's height comes from `aspect-ratio`, though the image itself
   *     lays out right (a 263-tall photo in a 0-tall row, measured); with a
   *     height of its own the row is right.
   *   - **One side left at 0** by the stylesheet (`height` alone): rebuilt
   *     with `auto-size`, which takes the other side from the picture. Lynx
   *     reads `auto-size` only when it creates the image (set later, even
   *     with `src` set again, it does nothing: measured).
   *   - **Both sides 0**: no size from the stylesheet, or a hidden parent.
   *     With a parent that has a width it is the former, and gets
   *     `auto-size`; otherwise it waits for a later layout.
   *
   * Returns whether an inline height changed, so the caller flushes again.
   */
  private syncImages(): boolean {
    const read = this.papi.computedStyle;
    if (!read) return false;
    const size = (el: LynxElement, key: 'width' | 'height'): number => Number.parseFloat(read(el.ref!, key)) || 0;
    let changed = false;
    const rebuild: LynxElement[] = [];
    for (const el of this.unmeasuredImages) {
      if (!el.ref || el.as !== 'image') {
        this.unmeasuredImages.delete(el);
        continue;
      }
      const w = size(el, 'width');
      const h = size(el, 'height');
      if (w > 0 && h > 0) {
        this.papi.setInlineStyles(el.ref, `height: ${h}px`);
        this.pinnedImages.set(el, { ratio: w / h, width: w });
        this.unmeasuredImages.delete(el);
        changed = true;
      } else if (w > 0 || h > 0 || (el.parent?.ref && size(el.parent, 'width') > 0)) {
        this.autoSizedImages.add(el);
        this.unmeasuredImages.delete(el);
        rebuild.push(el);
      }
    }
    for (const [el, pin] of this.pinnedImages) {
      if (!el.ref) continue;
      const w = size(el, 'width');
      if (w > 0 && Math.abs(w - pin.width) > 0.5) {
        this.papi.setInlineStyles(el.ref, `height: ${w / pin.ratio}px`);
        pin.width = w;
        changed = true;
      }
    }
    for (const el of rebuild) this.reproject(el);
    return changed;
  }

  /**
   * Lynx's `svg` resolves `currentColor` from its `current-color` attribute,
   * not from CSS `color`, so an icon drawn with `stroke="currentColor"`
   * would paint in the engine's default instead of the text colour around
   * it. After each flush, read each icon's computed `color` (inherited, so
   * it is the browser's `currentColor`) and hand it over when it changed.
   * Returns whether any changed.
   */
  private syncSvgColours(): boolean {
    const read = this.papi.computedStyle;
    if (!read) return false;
    let changed = false;
    for (const [el, last] of this.svgs) {
      if (!el.ref) continue;
      const colour = cssColour(read(el.ref, 'color'));
      if (!colour || colour === last) continue;
      this.papi.setAttribute(el.ref, 'current-color', colour);
      this.svgs.set(el, colour);
      changed = true;
    }
    return changed;
  }

  private resolve(src: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src === '') return src;
    const base = this.opts.baseUrl;
    if (!base) throw new LynxRefusalError(`<img src="${src}">`, "a relative url needs mountLynx's baseUrl");
    return resolveUrl(src, base);
  }
}

/** The engine reports some colours as `argb(a, r, g, b)` with alpha 0–255; CSS wants `rgba()`. */
function cssColour(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const m = /^argb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(v);
  if (!m) return v;
  const alpha = Math.round((Number(m[1]) / 255) * 1000) / 1000;
  return `rgba(${m[2]}, ${m[3]}, ${m[4]}, ${alpha})`;
}

/** `href` against `base`, for the cases server markup uses: absolute, `//host`, `/path`, `path`. */
export function resolveUrl(href: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/i.exec(base);
  if (!m) return href;
  const [, scheme, host, path] = m as unknown as [string, string, string, string];
  if (href.startsWith('//')) return `${scheme}${href}`;
  if (href.startsWith('/')) return `${scheme}//${host}${href}`;
  if (href.startsWith('?') || href.startsWith('#')) return `${scheme}//${host}${path}${href}`;
  const dir = path.slice(0, path.lastIndexOf('/') + 1) || '/';
  return `${scheme}//${host}${dir}${href}`;
}
