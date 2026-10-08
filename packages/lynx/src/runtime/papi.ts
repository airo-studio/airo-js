/**
 * The Element PAPI functions this package calls, read from the Lynx main
 * thread's globals. One object, so the rest of the runtime never touches a
 * `__Global` directly and a test can install the same globals a device has.
 *
 * Only main-thread code may create or mutate elements ("Element PAPI tree
 * creation and mutation must stay in main-thread.ts", vanilla plugin README).
 */

/** An element handle from the engine. Opaque: only PAPI functions read it. */
export type ElementRef = object;

/** What a function-callback listener receives (`MainThreadScriptEvent`). */
export interface NativeEvent {
  type?: string;
  target?: { uid?: number; elementRefptr?: unknown } | null;
  currentTarget?: { uid?: number } | null;
  detail?: { value?: unknown } & Record<string, unknown>;
}

export type NativeListener = (event: NativeEvent) => void;

export interface Papi {
  createPage(componentId: string, cssId: number): ElementRef;
  uniqueId(el: ElementRef): number;
  createView(pid: number): ElementRef;
  createScrollView(pid: number): ElementRef;
  createText(pid: number): ElementRef;
  createRawText(text: string): ElementRef;
  createImage(pid: number): ElementRef;
  createElement(tag: string, pid: number): ElementRef;
  append(parent: ElementRef, child: ElementRef): void;
  insertBefore(parent: ElementRef, child: ElementRef, before: ElementRef): void;
  remove(parent: ElementRef, child: ElementRef): void;
  replace(next: ElementRef, previous: ElementRef): void;
  setClasses(el: ElementRef, classes: string): void;
  setId(el: ElementRef, id: string | null): void;
  setAttribute(el: ElementRef, name: string, value: unknown): void;
  /** Inline styles, as a declaration list. Only for what a browser derives from markup, never author styling. */
  setInlineStyles(el: ElementRef, css: string): void;
  addEventListener(el: ElementRef, name: string, fn: NativeListener): void;
  removeEventListener(el: ElementRef, name: string, fn: NativeListener): void;
  invokeUIMethod(el: ElementRef, method: string, params: Record<string, unknown>): void;
  flush(): void;
  /**
   * `__GetComputedStyleByKey`, where the engine has it (iOS and Android do;
   * Lynx for Web did not in the spike). Answers only a few keys, `color`
   * among them.
   */
  computedStyle?: (el: ElementRef, key: string) => string;
}

export class LynxEnvironmentError extends Error {
  constructor(missing: string[]) {
    super(
      `[@airo-js/lynx] the Lynx main-thread globals ${missing.join(', ')} are missing. @airo-js/lynx/runtime runs only on the Lynx main thread (main-thread.ts of a vanilla card).`,
    );
    this.name = 'LynxEnvironmentError';
  }
}

const NAMES = [
  '__CreatePage',
  '__GetElementUniqueID',
  '__CreateView',
  '__CreateScrollView',
  '__CreateText',
  '__CreateRawText',
  '__CreateImage',
  '__CreateElement',
  '__AppendElement',
  '__InsertElementBefore',
  '__RemoveElement',
  '__ReplaceElement',
  '__SetClasses',
  '__SetID',
  '__SetAttribute',
  '__SetInlineStyles',
  '__AddEventListener',
  '__RemoveEventListener',
  '__InvokeUIMethod',
  '__FlushElementTree',
] as const;

type Fn = (...args: unknown[]) => unknown;

/** Bind the PAPI globals as they are now. Throws naming every one that is missing. */
export function getPapi(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): Papi {
  const missing = NAMES.filter((n) => typeof scope[n] !== 'function');
  if (missing.length) throw new LynxEnvironmentError([...missing]);
  const g = (name: (typeof NAMES)[number]): Fn => scope[name] as Fn;
  const options = {};
  return {
    createPage: (id, css) => g('__CreatePage')(id, css) as ElementRef,
    uniqueId: (el) => g('__GetElementUniqueID')(el) as number,
    createView: (pid) => g('__CreateView')(pid) as ElementRef,
    createScrollView: (pid) => g('__CreateScrollView')(pid) as ElementRef,
    createText: (pid) => g('__CreateText')(pid) as ElementRef,
    createRawText: (text) => g('__CreateRawText')(text) as ElementRef,
    createImage: (pid) => g('__CreateImage')(pid) as ElementRef,
    createElement: (tag, pid) => g('__CreateElement')(tag, pid) as ElementRef,
    append: (parent, child) => void g('__AppendElement')(parent, child),
    insertBefore: (parent, child, before) => void g('__InsertElementBefore')(parent, child, before),
    remove: (parent, child) => void g('__RemoveElement')(parent, child),
    replace: (next, previous) => void g('__ReplaceElement')(next, previous),
    setClasses: (el, classes) => void g('__SetClasses')(el, classes),
    setId: (el, id) => void g('__SetID')(el, id),
    setAttribute: (el, name, value) => void g('__SetAttribute')(el, name, value),
    setInlineStyles: (el, css) => void g('__SetInlineStyles')(el, css),
    addEventListener: (el, name, fn) => void g('__AddEventListener')(el, name, fn, options),
    removeEventListener: (el, name, fn) => void g('__RemoveEventListener')(el, name, fn, options),
    invokeUIMethod: (el, method, params) => void g('__InvokeUIMethod')(el, method, params, () => undefined),
    flush: () => void g('__FlushElementTree')(),
    ...(typeof scope.__GetComputedStyleByKey === 'function'
      ? { computedStyle: (el: ElementRef, key: string) => String((scope.__GetComputedStyleByKey as Fn)(el, key) ?? '') }
      : {}),
  };
}
