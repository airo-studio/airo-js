/**
 * The bounded DOM facade: the element objects hydrate code receives on
 * device, and the event system behind them.
 *
 * A cartridge's hydrate handlers were written against the browser DOM. On
 * Lynx there is no DOM, but most of what those handlers do — find elements,
 * read data attributes, show and hide, change text, listen for taps — maps
 * onto the node model and Element PAPI directly. So they run unchanged
 * against this fixed subset:
 *
 * | member | on device |
 * |---|---|
 * | `querySelector(All)`, `closest`, `matches`, `contains` | answered from the node model (`matcher.ts`) |
 * | `getAttribute`, `setAttribute`, `removeAttribute`, `hasAttribute`, `toggleAttribute`, `dataset`, `hidden`, `disabled`, `id`, `className`, `classList` | the model's attributes; every write also updates the element's mirror classes |
 * | `textContent`, `innerHTML`, `insertAdjacentHTML` | the model, re-projected through the tokenizer and tree pass |
 * | `value` | form controls: mirrored from the Lynx `input` event, pushed with `setValue`; a select's from its selected option |
 * | `open`, `show()`, `showModal()`, `close()`, `returnValue` | `<details>` and `<dialog>`: the `open` attribute, re-projected; `toggle` and `close` fire after the current task |
 * | `options`, `selectedIndex`, `selected`, `text` | `<select>` and `<option>`, by HTML's selectedness rules (`./select.ts`) |
 * | `checked` | checkboxes and radios; a checked radio unchecks the rest of its group |
 * | `files` | file inputs: the host's own objects, from `onPick`; `value = ''` clears them |
 * | `addEventListener`, `removeEventListener` | `click`, `input`, `change`, `submit`, `focus`, `blur`, `toggle`, `close` (below) |
 * | `tagName`, `nodeName`, `nodeType`, `parentElement` | read-only, from the model |
 *
 * Every other member, and every browser global that is not DOM (`window`,
 * `document`, `location`, `history`, storage, `navigator`, observers,
 * `fetch`), throws a `LynxRefusalError` naming it, after logging it and
 * reporting it to the host. The subset does not grow by accident: a new
 * member is a new line in the table above.
 *
 * ## Events
 *
 * ```
 *  Lynx (native)                          facade (what hydrate code sees)
 *  tap on any element ──────────────────► click, bubbling from the tapped element
 *                                           └─ not prevented, by the nearest of these around it:
 *                                              <a href> → onNavigate (link)
 *                                              submit button → submit on its form
 *                                                 └─ not prevented → onNavigate (form), or for
 *                                                    method="dialog", its dialog closes
 *                                              a details' summary → `open` toggles → toggle
 *                                              checkbox / radio → toggled first, then input, change
 *                                              file input → onPick → input, change
 *                                              <label> → a click on its control
 *                                              <select> → onPick → input, change
 *  … while a modal dialog is open, a tap outside it is a tap on the dialog (its backdrop)
 *  focus on input/textarea ─────────────► focus     (value remembered)
 *  input ───────────────────────────────► input     (value mirrored first)
 *  blur ────────────────────────────────► change if the value differs from focus, then blur
 *  confirm (return key) ────────────────► change if it differs; in an input inside a form,
 *                                           the form's default button is clicked, or a
 *                                           one-field form submits
 * ```
 *
 * One native `tap` listener on the page element feeds every `click`; the
 * facade walks the model from the tapped element to the root itself, so
 * `event.target`, `currentTarget` and `stopPropagation` behave as in a
 * browser whatever Lynx's own bubbling does.
 *
 * ## Failing
 *
 * Listeners attached during a hydrate call are recorded; if the call throws,
 * they are removed again, so a page is never half wired. A listener that
 * throws during an event is reported and the dispatch carries on, as a
 * browser's does.
 */

import { type ErrorReporter, type LynxErrorPhase, refuse, report } from './errors.js';
import { closest, matches, querySelector, querySelectorAll } from './matcher.js';
import {
  isDisabledOption,
  optionsOf,
  optionText,
  optionValue,
  type PickAnswer,
  type PickRequest,
  pickRequest,
  selectedOption,
  selectOf,
  selectOption,
} from './select.js';
import {
  type NavigateRequest,
  blockingFields,
  defaultButton,
  formOf,
  formRequest,
  hasPickedFiles,
  isSubmitButton,
  linkRequest,
} from './navigation.js';
import {
  contains,
  descendants,
  fromParsed,
  insertChildren,
  isCheckable,
  isFileInput,
  type LynxElement,
  type LynxNode,
  LynxText,
  serializeChildren,
  textContent,
} from './node-model.js';
import type { NativeEvent } from './papi.js';
import { tokenize } from './tokenize.js';
import type { ControlEvent, NativeTree } from './tree.js';

/** The events a listener can be added for on device. */
const SUPPORTED_EVENTS = new Set(['click', 'input', 'change', 'submit', 'focus', 'blur', 'toggle', 'close']);

/** What a tap activates besides a link or a summary; a tap inside one of these does not reach a summary around it. */
const ACTIVATABLE = new Set(['button', 'select', 'input', 'textarea']);

const isDetailsSummary = (el: LynxElement): boolean =>
  el.parent?.tag === 'details' && el.parent.children.find((c) => c.kind === 'element' && c.tag === 'summary') === el;

/** What a tap on `el` activates, as a browser finds it: the nearest link, control, label, or details' summary around it. */
function activationTarget(el: LynxElement): LynxElement | null {
  for (let n: LynxElement | null = el; n; n = n.parent) {
    if (n.tag === 'a' ? n.attrs.has('href') : ACTIVATABLE.has(n.tag) || n.tag === 'label' || (n.tag === 'summary' && isDetailsSummary(n))) return n;
  }
  return null;
}

const rootOf = (el: LynxElement): LynxElement => {
  let n = el;
  while (n.parent) n = n.parent;
  return n;
};

/** The control a label labels: its `for` target, else the first labelable element inside it. */
function labelledControl(label: LynxElement): LynxElement | null {
  const id = label.attrs.get('for');
  const scope = id === undefined ? label : rootOf(label);
  for (const el of descendants(scope)) {
    if (id !== undefined ? el.attrs.get('id') === id : LABELABLE.has(el.tag) && !(el.tag === 'input' && el.attrs.get('type')?.toLowerCase() === 'hidden')) {
      return LABELABLE.has(el.tag) ? el : null;
    }
  }
  return null;
}
const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);

/** The other radios a radio unchecks: same name, same form (or both in none), on the same page. */
function radioGroup(radio: LynxElement): LynxElement[] {
  const name = radio.attrs.get('name');
  if (!name) return [radio];
  const form = formOf(radio);
  return [...descendants(form ?? rootOf(radio))].filter(
    (el) => isCheckable(el) && el.attrs.get('type')?.toLowerCase() === 'radio' && el.attrs.get('name') === name && formOf(el) === form,
  );
}

/** Elements whose `value` reflects their `value` attribute. */
const VALUE_ATTRIBUTE_TAGS = new Set(['button', 'data', 'option', 'li', 'param', 'meter', 'progress']);

/** Keys that are introspection, not DOM use: answered as absent, never refused. */
const INERT_KEYS = new Set(['then', 'toJSON', 'asymmetricMatch', '$$typeof', 'constructor', 'nodeValue']);

type Listener = (event: FacadeEventLike) => unknown;

interface Registered {
  fn: Listener;
  once: boolean;
}

interface Recording {
  added: { el: LynxElement; type: string; fn: Listener }[];
}

/** What a listener receives. */
export interface FacadeEventLike {
  readonly type: string;
  readonly target: unknown;
  readonly currentTarget: unknown;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly defaultPrevented: boolean;
  readonly submitter?: unknown;
  readonly timeStamp: number;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export interface FacadeHostOptions {
  tree: NativeTree;
  reporter?: ErrorReporter;
  /** A link was tapped or a form submitted, and nothing prevented it. */
  navigate: (request: NavigateRequest) => void;
  /** A select or file input was tapped: the host shows the choice and resolves with it, or nothing. */
  pick?: (request: PickRequest) => Promise<PickAnswer> | PickAnswer;
}

const camel = (dataName: string): string => dataName.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const kebab = (key: string): string => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * One per mount: the element facades, the listener registry and the event
 * loop between Lynx and hydrate code.
 */
export class FacadeHost {
  readonly tree: NativeTree;
  /** Which phase a refusal belongs to, for the host's `onError`. */
  phase: LynxErrorPhase = 'hydrate';
  private readonly proxies = new WeakMap<LynxElement, object>();
  private readonly unwrapped = new WeakMap<object, LynxElement>();
  private readonly listeners = new Map<LynxElement, Map<string, Registered[]>>();
  private readonly recordings = new Set<Recording>();
  /** Dialogs opened with `showModal()`, oldest first. */
  private modals: LynxElement[] = [];
  private readonly returnValues = new WeakMap<LynxElement, string>();

  constructor(private readonly opts: FacadeHostOptions) {
    this.tree = opts.tree;
  }

  // ── refusals ──────────────────────────────────────────────────────────────

  refuse(member: string, detail?: string): never {
    return refuse(this.opts.reporter, this.phase, member, detail);
  }

  /** Run `fn`; a refusal or parse error is reported (once) and rethrown. */
  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw report(this.opts.reporter, this.phase, err);
    }
  }

  // ── facades ───────────────────────────────────────────────────────────────

  /** The object hydrate code holds for `el`. The same one every time. */
  facade(el: LynxElement): object {
    const hit = this.proxies.get(el);
    if (hit) return hit;
    const target = new ElementFacade(el, this);
    const proxy = refusingProxy(target, 'Element', ELEMENT_MEMBERS, ELEMENT_SETTABLE, this);
    this.proxies.set(el, proxy);
    this.unwrapped.set(proxy, el);
    return proxy;
  }

  /** The model element behind a facade, or null for anything else. */
  unwrap(value: unknown): LynxElement | null {
    return (typeof value === 'object' && value !== null && this.unwrapped.get(value)) || null;
  }

  // ── attributes: the one write path, so mirror classes never lag ───────────

  setAttribute(el: LynxElement, name: string, value: string): void {
    const key = el.foreign ? name : name.toLowerCase();
    const added = !el.attrs.has(key);
    el.attrs.set(key, value);
    if (key === 'value' && (el.tag === 'input' || el.tag === 'textarea') && !el.valueDirty) {
      el.value = value;
      this.tree.pushValue(el);
    }
    if (added) this.presenceChanged(el, key, true);
    this.tree.refreshAttributes(el, key);
  }

  removeAttribute(el: LynxElement, name: string): void {
    const key = el.foreign ? name : name.toLowerCase();
    if (!el.attrs.delete(key)) return;
    this.presenceChanged(el, key, false);
    this.tree.refreshAttributes(el, key);
  }

  /** What a browser does, beyond restyling, when one of these attributes comes or goes. */
  private presenceChanged(el: LynxElement, key: string, present: boolean): void {
    if (el.foreign) return;
    if (key === 'open' && el.tag === 'details') {
      this.queue(el, 'toggle');
    } else if (key === 'open' && el.tag === 'dialog' && !present) {
      el.modal = false;
      this.modals = this.modals.filter((m) => m !== el);
    } else if (key === 'checked' && isCheckable(el)) {
      // The attribute sets checkedness until a tap or a script has.
      if (!el.checkedDirty) this.setChecked(el, present);
    } else if (key === 'selected' && el.tag === 'option') {
      // The attribute sets selectedness until the selection has been set by a pick or a script.
      const select = selectOf(el);
      if (select?.valueDirty) return;
      el.selected = present;
      if (present && select) for (const o of optionsOf(select)) if (o !== el) o.selected = false;
    }
  }

  /** Check or uncheck a checkbox or radio (a checked radio unchecks the rest of its group), and restyle. */
  setChecked(el: LynxElement, on: boolean): void {
    if (on && el.attrs.get('type')?.toLowerCase() === 'radio') {
      for (const other of radioGroup(el)) {
        if (other !== el && other.checked) {
          other.checked = false;
          this.tree.restyle(other);
        }
      }
    }
    if (el.checked === on) return;
    el.checked = on;
    this.tree.restyle(el);
  }

  /**
   * A checkbox or radio toggles before its click is dispatched, as in a
   * browser, so handlers read the new state. Returns how to put it back if
   * the click is cancelled, or null when nothing changed (a checked radio).
   */
  private preActivate(el: LynxElement): (() => void) | null {
    const radio = el.attrs.get('type')?.toLowerCase() === 'radio';
    if (radio && el.checked) return null;
    const before = radioGroup(el).filter((r) => r.checked);
    const was = el.checked;
    el.checkedDirty = true;
    this.setChecked(el, radio ? true : !was);
    return () => {
      this.setChecked(el, was);
      for (const r of before) this.setChecked(r, true);
    };
  }

  /** Fire a non-bubbling `type` at `el` once the current task is done, as a browser's element task does. */
  private queue(el: LynxElement, type: string): void {
    void Promise.resolve().then(() => this.dispatch(el, type, { bubbles: false, cancelable: false }));
  }

  // ── dialogs ───────────────────────────────────────────────────────────────

  /** `dialog.show()` / `showModal()`. */
  showDialog(el: LynxElement, modal: boolean): void {
    if (el.attrs.has('open')) {
      if (el.modal === modal) return;
      const err = new Error(
        `[@airo-js/lynx] <dialog>.${modal ? 'showModal' : 'show'}(): the dialog is already open ${el.modal ? 'as a modal' : 'without a backdrop'}`,
      );
      err.name = 'InvalidStateError';
      throw report(this.opts.reporter, this.phase, err);
    }
    el.modal = modal;
    if (modal) this.modals.push(el);
    this.setAttribute(el, 'open', '');
  }

  /** `dialog.close(result)`, and a `method="dialog"` form's submission. */
  closeDialog(el: LynxElement, result?: string): void {
    if (!el.attrs.has('open')) return;
    if (result !== undefined) this.returnValues.set(el, result);
    this.removeAttribute(el, 'open');
    this.queue(el, 'close');
  }

  returnValue(el: LynxElement): string {
    return this.returnValues.get(el) ?? '';
  }

  setReturnValue(el: LynxElement, value: string): void {
    this.returnValues.set(el, value);
  }

  /** The modal on top, if one is open on the page on screen. */
  private topModal(): LynxElement | null {
    const root = this.tree.viewport;
    for (let i = this.modals.length - 1; i >= 0; i--) {
      const m = this.modals[i]!;
      if (m.modal && (!root || contains(root, m))) return m;
    }
    return null;
  }

  // ── selects ───────────────────────────────────────────────────────────────

  /** Select `option` (null: none) by script: the label changes, no event fires. */
  select(select: LynxElement, option: LynxElement | null): void {
    selectOption(select, option);
    this.tree.reproject(select);
  }

  /** A tapped select: ask the host, then apply its answer as a user's pick. */
  private pick(select: LynxElement): void {
    const ask = this.opts.pick;
    const name = select.attrs.get('name');
    const named = `<select${name ? ` name="${name}"` : ''}>`;
    if (!ask) {
      report(this.opts.reporter, 'event', new Error(`[@airo-js/lynx] ${named} was tapped: mountLynx has no onPick to show the choice`));
      return;
    }
    const request = pickRequest(select);
    // Asked within the tap, so the host's picker opens in the same frame; a throw becomes a rejection.
    new Promise<PickAnswer>((resolve) => resolve(ask(request)))
      .then((value) => {
        if (value === null || value === undefined) return;
        if (typeof value !== 'string') throw new Error(`[@airo-js/lynx] onPick answered ${named} with something that is not a value`);
        const root = this.tree.viewport;
        if (root && !contains(root, select)) return;
        const option = optionsOf(select).find((o) => optionValue(o) === value && !isDisabledOption(o));
        if (!option) throw new Error(`[@airo-js/lynx] onPick answered "${value}" for ${named}, which has no enabled option of that value`);
        if (option === selectedOption(select)) return;
        this.select(select, option);
        this.dispatch(select, 'input', { bubbles: true, cancelable: false });
        this.dispatch(select, 'change', { bubbles: true, cancelable: false });
      })
      .catch((err: unknown) => {
        report(this.opts.reporter, 'event', err);
      });
  }

  // ── content ───────────────────────────────────────────────────────────────

  /** Parse and check markup before anything changes, so a refusal leaves the page as it was. */
  parse(html: string): LynxNode[] {
    const nodes = fromParsed(tokenize(html));
    this.tree.validate(nodes);
    return nodes;
  }

  replaceChildren(el: LynxElement, nodes: LynxNode[]): void {
    for (const child of el.children) child.parent = null;
    el.children = [];
    insertChildren(el, nodes);
    this.tree.reproject(el);
  }

  // ── listeners ─────────────────────────────────────────────────────────────

  addListener(el: LynxElement, type: string, fn: Listener, once: boolean): void {
    const byType = this.listeners.get(el) ?? new Map<string, Registered[]>();
    const list = byType.get(type) ?? [];
    if (list.some((r) => r.fn === fn)) return;
    list.push({ fn, once });
    byType.set(type, list);
    this.listeners.set(el, byType);
    for (const r of this.recordings) r.added.push({ el, type, fn });
  }

  removeListener(el: LynxElement, type: string, fn: Listener): void {
    const list = this.listeners.get(el)?.get(type);
    if (!list) return;
    const i = list.findIndex((r) => r.fn === fn);
    if (i !== -1) list.splice(i, 1);
  }

  /** Start recording the listeners attached from now on. */
  record(): Recording {
    const r: Recording = { added: [] };
    this.recordings.add(r);
    return r;
  }

  stopRecording(r: Recording): void {
    this.recordings.delete(r);
  }

  /** Remove every listener a recording saw added. */
  rollback(r: Recording): void {
    this.recordings.delete(r);
    for (const { el, type, fn } of r.added) this.removeListener(el, type, fn);
  }

  /** How many listeners are attached in total; for tests and the device script. */
  listenerCount(): number {
    let n = 0;
    for (const byType of this.listeners.values()) for (const list of byType.values()) n += list.length;
    return n;
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  /** Dispatch a facade event at `target`, bubbling to the root when it bubbles. */
  dispatch(
    target: LynxElement,
    type: string,
    init: { bubbles: boolean; cancelable: boolean; submitter?: LynxElement | null },
  ): FacadeEventLike {
    const event = new FacadeEvent(type, this.facade(target), init.bubbles, init.cancelable, init.submitter ? this.facade(init.submitter) : undefined);
    const proxy = refusingProxy(event, 'Event', EVENT_MEMBERS, EVENT_SETTABLE, this) as FacadeEventLike;
    const path: LynxElement[] = [];
    for (let n: LynxElement | null = target; n; n = n.parent) {
      path.push(n);
      if (!init.bubbles) break;
    }
    const prior = this.phase;
    this.phase = 'event';
    try {
      for (const el of path) {
        const list = this.listeners.get(el)?.get(type);
        if (!list?.length) continue;
        event.currentTarget = this.facade(el);
        for (const registered of [...list]) {
          if (registered.once) this.removeListener(el, type, registered.fn);
          try {
            registered.fn.call(event.currentTarget, proxy);
          } catch (err) {
            report(this.opts.reporter, 'event', err);
          }
          if (event.immediateStopped) break;
        }
        if (event.stopped) break;
      }
    } finally {
      this.phase = prior;
      event.currentTarget = null;
    }
    return proxy;
  }

  /** A tap on `el`: `click`, then the browser's default action for what it activates. */
  click(el: LynxElement): void {
    const target = activationTarget(el);
    // A disabled control gets no click at all.
    if (target && ACTIVATABLE.has(target.tag) && target.attrs.has('disabled')) return;
    const undo = target && isCheckable(target) ? this.preActivate(target) : null;
    const event = this.dispatch(el, 'click', { bubbles: true, cancelable: true });
    if (event.defaultPrevented) {
      undo?.();
      return;
    }
    if (!target) return;
    switch (target.tag) {
      case 'input':
        if (isFileInput(target)) this.pickFiles(target);
        else if (undo) {
          this.dispatch(target, 'input', { bubbles: true, cancelable: false });
          this.dispatch(target, 'change', { bubbles: true, cancelable: false });
        }
        return;
      case 'label': {
        // The label passes the click to its control, which then does what a tap on it does.
        const control = labelledControl(target);
        if (control && control !== el && !contains(control, el)) this.click(control);
        return;
      }
      case 'a': {
        const request = linkRequest(target);
        if (request) this.opts.navigate(request);
        return;
      }
      case 'button': {
        const form = isSubmitButton(target) ? formOf(target) : null;
        if (form) this.submit(form, target);
        return;
      }
      case 'summary': {
        const details = target.parent!;
        if (details.attrs.has('open')) this.removeAttribute(details, 'open');
        else this.setAttribute(details, 'open', '');
        return;
      }
      case 'select':
        this.pick(target);
        return;
      default:
        return;
    }
  }

  /** A tapped file input: ask the host for files, then set them as a user's choice. */
  private pickFiles(input: LynxElement): void {
    const ask = this.opts.pick;
    const name = input.attrs.get('name');
    const named = `<input type="file"${name ? ` name="${name}"` : ''}>`;
    if (!ask) {
      report(this.opts.reporter, 'event', new Error(`[@airo-js/lynx] ${named} was tapped: mountLynx has no onPick to choose files`));
      return;
    }
    const request: PickRequest = { kind: 'file', name: name ?? '', accept: input.attrs.get('accept') ?? '', multiple: input.attrs.has('multiple') };
    new Promise<PickAnswer>((resolve) => resolve(ask(request)))
      .then((files) => {
        if (files === null || files === undefined) return;
        if (!Array.isArray(files)) throw new Error(`[@airo-js/lynx] onPick answered ${named} with something that is not a list of files`);
        if (files.length === 0) return;
        const root = this.tree.viewport;
        if (root && !contains(root, input)) return;
        input.files = Object.freeze(request.multiple ? [...files] : [files[0]]);
        this.dispatch(input, 'input', { bubbles: true, cancelable: false });
        this.dispatch(input, 'change', { bubbles: true, cancelable: false });
      })
      .catch((err: unknown) => {
        report(this.opts.reporter, 'event', err);
      });
  }

  /** Submit `form`: a cancellable `submit`, then the request, or for `method="dialog"` the dialog's close. */
  submit(form: LynxElement, submitter: LynxElement | null): void {
    const event = this.dispatch(form, 'submit', { bubbles: true, cancelable: true, submitter });
    if (event.defaultPrevented) return;
    if (hasPickedFiles(form)) {
      // A request's fields are strings, so the files would be dropped without a word.
      report(this.opts.reporter, 'event', new Error('[@airo-js/lynx] a form holding a picked file was submitted: onNavigate cannot carry files; upload them through the host\'s fetch instead'));
      return;
    }
    const request = formRequest(form, submitter);
    if (request) {
      this.opts.navigate(request);
      return;
    }
    const dialog = closest(form, 'dialog');
    if (dialog) this.closeDialog(dialog, submitter ? (submitter.attrs.get('value') ?? '') : undefined);
  }

  /** The page's native `tap`, as Lynx delivers it. */
  onTap(native: NativeEvent): void {
    const target = native.target;
    let el = typeof target?.uid === 'number' ? this.tree.byUid.get(target.uid) : undefined;
    if (!el && target?.elementRefptr) {
      el = this.tree.byUid.get(this.tree.papi.uniqueId(target.elementRefptr as object));
    }
    if (!el) return;
    // The page below a modal is inert: a tap outside it lands on its backdrop, which is the dialog.
    const modal = this.topModal();
    this.click(modal && !contains(modal, el) ? modal : el);
  }

  /** A form control's native event (registered by the tree pass). */
  onControlEvent(el: LynxElement, kind: ControlEvent, native: NativeEvent): void {
    const value = native.detail?.value;
    const update = (): void => {
      if (typeof value === 'string' && value !== el.value) {
        el.value = value;
        el.valueDirty = true;
      }
    };
    const commit = (): void => {
      if (el.valueAtFocus !== null && el.value !== el.valueAtFocus) {
        this.dispatch(el, 'change', { bubbles: true, cancelable: false });
      }
      el.valueAtFocus = el.value;
    };
    switch (kind) {
      case 'focus':
        update();
        el.valueAtFocus = el.value;
        this.dispatch(el, 'focus', { bubbles: false, cancelable: false });
        break;
      case 'input':
        el.valueAtFocus ??= el.value;
        update();
        this.dispatch(el, 'input', { bubbles: true, cancelable: false });
        break;
      case 'blur':
        update();
        commit();
        el.valueAtFocus = null;
        this.dispatch(el, 'blur', { bubbles: false, cancelable: false });
        break;
      case 'confirm': {
        update();
        commit();
        if (el.as !== 'input') break;
        const form = formOf(el);
        if (!form) break;
        const button = defaultButton(form);
        if (button) this.click(button);
        else if (blockingFields(form) === 1) this.submit(form, null);
        break;
      }
    }
  }
}

// ── the element facade ───────────────────────────────────────────────────────

class ClassList {
  constructor(
    private readonly el: LynxElement,
    private readonly host: FacadeHost,
  ) {}
  private get tokens(): string[] {
    return (this.el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  }
  private write(tokens: string[]): void {
    this.host.setAttribute(this.el, 'class', [...new Set(tokens)].join(' '));
  }
  get length(): number {
    return this.tokens.length;
  }
  get value(): string {
    return this.el.attrs.get('class') ?? '';
  }
  contains(token: string): boolean {
    return this.tokens.includes(token);
  }
  add(...tokens: string[]): void {
    this.write([...this.tokens, ...tokens]);
  }
  remove(...tokens: string[]): void {
    this.write(this.tokens.filter((t) => !tokens.includes(t)));
  }
  toggle(token: string, force?: boolean): boolean {
    const on = force ?? !this.contains(token);
    if (on) this.add(token);
    else this.remove(token);
    return on;
  }
  toString(): string {
    return this.value;
  }
}

class ElementFacade {
  readonly #el: LynxElement;
  readonly #host: FacadeHost;

  constructor(el: LynxElement, host: FacadeHost) {
    this.#el = el;
    this.#host = host;
  }

  // structure (read-only)
  get nodeType(): number {
    return 1;
  }
  get tagName(): string {
    return this.#el.foreign ? this.#el.tag : this.#el.tag.toUpperCase();
  }
  get nodeName(): string {
    return this.tagName;
  }
  get parentElement(): object | null {
    return this.#el.parent ? this.#host.facade(this.#el.parent) : null;
  }

  // queries
  querySelector(selector: string): object | null {
    const el = this.#host.guard(() => querySelector(this.#el, selector));
    return el && this.#host.facade(el);
  }
  querySelectorAll(selector: string): object[] {
    return this.#host.guard(() => querySelectorAll(this.#el, selector)).map((el) => this.#host.facade(el));
  }
  closest(selector: string): object | null {
    const el = this.#host.guard(() => closest(this.#el, selector));
    return el && this.#host.facade(el);
  }
  matches(selector: string): boolean {
    return this.#host.guard(() => matches(this.#el, selector));
  }
  contains(other: unknown): boolean {
    const el = this.#host.unwrap(other);
    return !!el && contains(this.#el, el);
  }

  // attributes
  getAttribute(name: string): string | null {
    return this.#el.attrs.get(this.#el.foreign ? name : name.toLowerCase()) ?? null;
  }
  setAttribute(name: string, value: unknown): void {
    this.#host.setAttribute(this.#el, name, String(value));
  }
  removeAttribute(name: string): void {
    this.#host.removeAttribute(this.#el, name);
  }
  hasAttribute(name: string): boolean {
    return this.#el.attrs.has(this.#el.foreign ? name : name.toLowerCase());
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on && !this.hasAttribute(name)) this.setAttribute(name, '');
    else if (!on) this.removeAttribute(name);
    return on;
  }
  get dataset(): Record<string, string | undefined> {
    const el = this.#el;
    const host = this.#host;
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_, key) => (typeof key === 'string' ? el.attrs.get(kebab(key)) : undefined),
      set: (_, key, value) => {
        if (typeof key === 'string') host.setAttribute(el, kebab(key), String(value));
        return true;
      },
      deleteProperty: (_, key) => {
        if (typeof key === 'string') host.removeAttribute(el, kebab(key));
        return true;
      },
      has: (_, key) => typeof key === 'string' && el.attrs.has(kebab(key)),
      ownKeys: () => [...el.attrs.keys()].filter((k) => k.startsWith('data-')).map(camel),
      getOwnPropertyDescriptor: (_, key) =>
        typeof key === 'string' && el.attrs.has(kebab(key))
          ? { enumerable: true, configurable: true, writable: true, value: el.attrs.get(kebab(key)) }
          : undefined,
    });
  }
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }
  set hidden(on: boolean) {
    this.toggleAttribute('hidden', !!on);
  }
  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }
  set disabled(on: boolean) {
    this.toggleAttribute('disabled', !!on);
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  set id(value: string) {
    this.setAttribute('id', value);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  get classList(): ClassList {
    return new ClassList(this.#el, this.#host);
  }

  // content
  get textContent(): string {
    return textContent(this.#el);
  }
  set textContent(value: string | null) {
    const text = value === null || value === undefined ? '' : String(value);
    this.#host.replaceChildren(this.#el, text ? [new LynxText(text)] : []);
  }
  get innerHTML(): string {
    return serializeChildren(this.#el);
  }
  set innerHTML(html: string) {
    const nodes = this.#host.guard(() => this.#host.parse(String(html)));
    this.#host.replaceChildren(this.#el, nodes);
  }
  insertAdjacentHTML(position: string, html: string): void {
    const el = this.#el;
    const host = this.#host;
    const nodes = host.guard(() => host.parse(String(html)));
    const where = position.toLowerCase();
    if (where === 'afterbegin' || where === 'beforeend') {
      insertChildren(el, nodes, where === 'afterbegin' ? 0 : el.children.length);
      host.tree.reproject(el);
      return;
    }
    if (where !== 'beforebegin' && where !== 'afterend') host.refuse(`Element.insertAdjacentHTML("${position}")`, 'not a position');
    const parent = el.parent ?? host.refuse('Element.insertAdjacentHTML', 'the root element has no siblings on device');
    const index = parent.children.indexOf(el) + (where === 'afterend' ? 1 : 0);
    insertChildren(parent, nodes, index);
    host.tree.reproject(parent);
  }

  // form controls
  get value(): string {
    const el = this.#el;
    if (isFileInput(el)) {
      const first = el.files[0] as { name?: unknown } | undefined;
      return first ? `C:\\fakepath\\${typeof first.name === 'string' ? first.name : ''}` : '';
    }
    if (el.tag === 'input' || el.tag === 'textarea') return el.value;
    if (el.tag === 'select') {
      const selected = selectedOption(el);
      return selected ? optionValue(selected) : '';
    }
    if (el.tag === 'option') return optionValue(el);
    if (VALUE_ATTRIBUTE_TAGS.has(el.tag)) return el.attrs.get('value') ?? '';
    return this.#host.refuse(`<${el.tag}>.value`);
  }
  set value(value: string) {
    const el = this.#el;
    if (isFileInput(el)) {
      // A browser lets a script clear a file input, and nothing else.
      if (String(value) !== '') this.#host.refuse('setting <input type="file">.value', 'only to "", which clears it');
      el.files = [];
      return;
    }
    if (el.tag === 'input' || el.tag === 'textarea') {
      el.value = String(value);
      el.valueDirty = true;
      this.#host.tree.pushValue(el);
      return;
    }
    if (el.tag === 'select') {
      this.#host.select(el, optionsOf(el).find((o) => optionValue(o) === String(value)) ?? null);
      return;
    }
    if (VALUE_ATTRIBUTE_TAGS.has(el.tag)) {
      this.setAttribute('value', value);
      return;
    }
    this.#host.refuse(`setting <${el.tag}>.value`);
  }

  // file input
  get files(): readonly unknown[] {
    const el = this.#el;
    if (!isFileInput(el)) return this.#host.refuse(`<${el.tag}>.files`);
    return el.files;
  }

  // checkbox and radio
  get checked(): boolean {
    return this.#checkable('checked').checked;
  }
  set checked(on: boolean) {
    const el = this.#checkable('checked');
    el.checkedDirty = true;
    this.#host.setChecked(el, !!on);
  }

  #checkable(member: string): LynxElement {
    const el = this.#el;
    if (!isCheckable(el)) return this.#host.refuse(`<${el.tag}${el.tag === 'input' ? ` type="${el.attrs.get('type') ?? 'text'}"` : ''}>.${member}`);
    return el;
  }

  // select and option
  get options(): object[] {
    return optionsOf(this.#only('select', 'options')).map((o) => this.#host.facade(o));
  }
  get selectedIndex(): number {
    const select = this.#only('select', 'selectedIndex');
    const selected = selectedOption(select);
    return selected ? optionsOf(select).indexOf(selected) : -1;
  }
  set selectedIndex(index: number) {
    const select = this.#only('select', 'selectedIndex');
    this.#host.select(select, optionsOf(select)[Number(index)] ?? null);
  }
  get selected(): boolean {
    const option = this.#only('option', 'selected');
    const select = selectOf(option);
    return select ? selectedOption(select) === option : option.selected;
  }
  set selected(on: boolean) {
    const option = this.#only('option', 'selected');
    const select = selectOf(option);
    if (!select) {
      option.selected = !!on;
      return;
    }
    if (on) this.#host.select(select, option);
    else if (selectedOption(select) === option) this.#host.select(select, null);
  }
  get text(): string {
    return optionText(this.#only('option', 'text'));
  }

  // details and dialog
  get open(): boolean {
    return this.#only(['details', 'dialog'], 'open').attrs.has('open');
  }
  set open(on: boolean) {
    this.#only(['details', 'dialog'], 'open');
    this.toggleAttribute('open', !!on);
  }
  show(): void {
    this.#host.showDialog(this.#only('dialog', 'show()'), false);
  }
  showModal(): void {
    this.#host.showDialog(this.#only('dialog', 'showModal()'), true);
  }
  close(result?: unknown): void {
    this.#host.closeDialog(this.#only('dialog', 'close()'), result === undefined ? undefined : String(result));
  }
  get returnValue(): string {
    return this.#host.returnValue(this.#only('dialog', 'returnValue'));
  }
  set returnValue(value: string) {
    this.#host.setReturnValue(this.#only('dialog', 'returnValue'), String(value));
  }

  /** The element, when it is one of `tags`; a refusal naming the member otherwise. */
  #only(tags: string | readonly string[], member: string): LynxElement {
    const el = this.#el;
    if (el.foreign || !(typeof tags === 'string' ? [tags] : tags).includes(el.tag)) return this.#host.refuse(`<${el.tag}>.${member}`);
    return el;
  }

  // events
  addEventListener(type: string, fn: unknown, options?: boolean | { capture?: boolean; once?: boolean; passive?: boolean; signal?: unknown }): void {
    const host = this.#host;
    if (!SUPPORTED_EVENTS.has(type)) host.refuse(`addEventListener("${type}")`, `the device delivers ${[...SUPPORTED_EVENTS].join(', ')}`);
    if (typeof fn !== 'function') host.refuse('addEventListener(type, { handleEvent })', 'pass a function');
    const opts = typeof options === 'object' && options !== null ? options : { capture: options === true };
    if (opts.capture) host.refuse(`addEventListener("${type}", fn, { capture: true })`, 'events bubble only on device');
    if ('signal' in opts && opts.signal !== undefined) host.refuse(`addEventListener("${type}", fn, { signal })`);
    host.addListener(this.#el, type, fn as Listener, !!opts.once);
  }
  removeEventListener(type: string, fn: unknown): void {
    this.#host.removeListener(this.#el, type, fn as Listener);
  }

  toString(): string {
    return `[object LynxFacadeElement <${this.#el.tag}>]`;
  }
}

class FacadeEvent {
  currentTarget: object | null = null;
  defaultPrevented = false;
  stopped = false;
  immediateStopped = false;
  readonly timeStamp = Date.now();

  constructor(
    readonly type: string,
    readonly target: object,
    readonly bubbles: boolean,
    readonly cancelable: boolean,
    readonly submitter: object | undefined,
  ) {}

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
  stopImmediatePropagation(): void {
    this.stopped = true;
    this.immediateStopped = true;
  }
}

export const membersOf = (proto: object): Set<string> =>
  new Set(Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor'));

const ELEMENT_MEMBERS = membersOf(ElementFacade.prototype);
const ELEMENT_SETTABLE = new Set([
  'hidden',
  'disabled',
  'id',
  'className',
  'textContent',
  'innerHTML',
  'value',
  'selectedIndex',
  'selected',
  'checked',
  'open',
  'returnValue',
]);
const EVENT_MEMBERS = new Set([
  ...membersOf(FacadeEvent.prototype),
  'type',
  'target',
  'currentTarget',
  'bubbles',
  'cancelable',
  'defaultPrevented',
  'submitter',
  'timeStamp',
]);
const EVENT_SETTABLE = new Set<string>();

/**
 * Wrap `target` so that reading or writing anything outside `members`
 * throws a named refusal. Methods are bound to the target, so private
 * fields work and the proxy never sees its own internals.
 */
export function refusingProxy(target: object, kind: string, members: ReadonlySet<string>, settable: ReadonlySet<string>, host: FacadeHost): object {
  return new Proxy(target, {
    get(t, key) {
      if (typeof key === 'symbol') return Reflect.get(t, key, t);
      if (members.has(key)) {
        const value = Reflect.get(t, key, t);
        return typeof value === 'function' ? value.bind(t) : value;
      }
      if (INERT_KEYS.has(key)) return undefined;
      return host.refuse(`${kind}.${key}`);
    },
    set(t, key, value) {
      if (typeof key === 'string' && settable.has(key)) return Reflect.set(t, key, value, t);
      return host.refuse(`setting ${kind}.${String(key)}`);
    },
    has(_, key) {
      return typeof key === 'string' && members.has(key);
    },
  });
}

// ── browser globals ──────────────────────────────────────────────────────────

/**
 * Browser globals that are not DOM: host capabilities (M13) or not on
 * device. `URL` and `Intl` are missing from the main thread's engine; a
 * guard turns "Intl is not defined" into a refusal the host's `onError`
 * hears. Only uses after the mount starts: a module that builds an
 * `Intl.DateTimeFormat` as it is imported runs before any mount exists.
 */
const GUARDED_GLOBALS = [
  'window',
  'document',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'navigator',
  'fetch',
  'XMLHttpRequest',
  'IntersectionObserver',
  'ResizeObserver',
  'MutationObserver',
  'matchMedia',
  'getComputedStyle',
  'requestAnimationFrame',
  'setInterval',
  'clearInterval',
  'URL',
  'URLSearchParams',
  'Intl',
  'alert',
  'confirm',
  'prompt',
] as const;

/**
 * Built-in methods the main thread's engine lacks, which code calls as if
 * every engine had them: a missing one fails as a bare "not a function"
 * with a minified stack. Each is installed, where missing, as a method that
 * refuses by name. `normalize` is Unicode data, as `Intl` is.
 */
const GUARDED_METHODS = [['String', 'normalize']] as const;

/** What the mount gives hydrate code in place of a guard: as a global where the engine lacks it, and as `window.<name>`. */
export interface ProvidedGlobals {
  /** Installed as globals only where the main thread has none. */
  globals: Record<string, unknown>;
  /** Answered from `window.<name>`; every other member of `window` is refused. */
  window: Record<string, unknown>;
}

/**
 * Define each guarded global the main thread lacks as an object that
 * refuses every use by name: `window.location.assign(…)` fails as
 * "window.location is not available on device" instead of "window is not
 * defined". What `provided` gives is installed instead: the mount's timers,
 * `FormData`, and the host's `fetch` when it lends one. Globals the engine
 * provides are left alone. Returns the undo.
 */
export function installGlobalGuards(
  host: FacadeHost,
  provided: ProvidedGlobals = { globals: {}, window: {} },
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): () => void {
  const installed: string[] = [];
  for (const name of new Set<string>([...GUARDED_GLOBALS, ...Object.keys(provided.globals)])) {
    if (name in scope) continue;
    if (name in provided.globals) {
      Object.defineProperty(scope, name, { value: provided.globals[name], configurable: true, writable: true });
      installed.push(name);
      continue;
    }
    const guard = new Proxy(function guarded() {}, {
      get(_, key) {
        if (typeof key === 'symbol' || INERT_KEYS.has(key) || key === 'prototype') return undefined;
        if (name === 'window' && key in provided.window) return provided.window[key];
        return host.refuse(`${name}.${key}`);
      },
      set(_, key) {
        return host.refuse(`setting ${name}.${String(key)}`);
      },
      apply() {
        return host.refuse(`${name}()`);
      },
      construct() {
        return host.refuse(`new ${name}()`);
      },
    });
    Object.defineProperty(scope, name, { value: guard, configurable: true, writable: true });
    installed.push(name);
  }
  const methods: [Record<string, unknown>, string][] = [];
  for (const [owner, method] of GUARDED_METHODS) {
    const proto = (scope[owner] as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    if (!proto || typeof proto[method] === 'function') continue;
    Object.defineProperty(proto, method, {
      value: function refused(): never {
        return host.refuse(`${owner}.prototype.${method}`);
      },
      configurable: true,
      writable: true,
    });
    methods.push([proto, method]);
  }
  return () => {
    for (const name of installed) delete scope[name];
    for (const [proto, method] of methods) delete proto[method];
  };
}

