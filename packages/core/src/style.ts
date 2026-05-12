/**
 * Style isolation strategies — Strategy pattern, two modes.
 *
 *   'light'   — no shadow boundary. Widget renders into the host's light
 *               DOM. Stylesheets target document.head. Compatibility mode
 *               for hosts that need widget styles to flow into the page
 *               (and accept the cost of host CSS leaking in).
 *   'shadow'  — attach shadow root. Widget styles scoped to the shadow.
 *               Framework injects ZERO CSS — cartridges decide their own
 *               sandbox posture by shipping `:host { all: initial }` (full
 *               sandbox), font-family inheritance rules (let host typography
 *               cascade), or whatever else they want in their own
 *               `ViewDefinition.stylesheet`.
 *
 * Pure DOM. No domain knowledge, no visual policy — the framework owns the
 * shadow-boundary mechanism only; cartridges own every CSS rule that lands
 * inside it.
 *
 * Declarative Shadow DOM (DSD) support: when `host.shadowRoot` is already
 * non-null at setup time (the browser parsed `<template shadowrootmode>`
 * during initial HTML parse, or a previous mount left a shadow attached),
 * `setupIsolationRoot` adopts the existing shadow instead of attaching a
 * new one. Existing shadow content gets auto-wrapped into the
 * `.airo-shadow-root` wrapper if not already present — moving nodes inside
 * a shadow root preserves style attribution and shadow scoping.
 */

export type StyleIsolation = 'light' | 'shadow';

export interface IsolationRoot {
  /** Element renderers paint into. Light-DOM host for 'light', a wrapper
   *  inside the shadow root for 'shadow'. */
  renderRoot: HTMLElement;
  /** Where stylesheets append. document.head for 'light', the ShadowRoot
   *  for 'shadow'. */
  styleRoot: ShadowRoot | HTMLHeadElement;
  /** True if a shadow boundary was attached. */
  isolated: boolean;
}

const SHADOW_WRAPPER_CLASS = 'airo-shadow-root';

/**
 * Attach a shadow root (if mode demands it) and create a render wrapper
 * inside. Idempotent — call twice on the same host and you get the same
 * `renderRoot` back without re-attaching.
 */
export function setupIsolationRoot(
  host: HTMLElement,
  mode: StyleIsolation,
): IsolationRoot {
  if (mode === 'light') {
    return {
      renderRoot: host,
      styleRoot: document.head,
      isolated: false,
    };
  }

  // attachShadow throws on re-attach — re-use an existing shadow root if
  // init runs twice on the same host (hot reload, re-init scenarios) or
  // if the browser already attached one via Declarative Shadow DOM
  // (`<template shadowrootmode="open">` parsed during initial HTML parse —
  // the zero-FOUC SSR path).
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  let wrapper = shadow.querySelector<HTMLElement>(`.${SHADOW_WRAPPER_CLASS}`);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = SHADOW_WRAPPER_CLASS;

    // If the shadow root already has children (declarative SSR emitted
    // content directly under <template shadowrootmode> without the
    // wrapper, or any other DSD shape), move them into the wrapper so
    // the framework's renderRoot contract (HTMLElement) is satisfied
    // without forcing cartridge authors to know about the wrapper class.
    // Moving nodes inside a shadow root preserves shadow scoping — CSS
    // attribution is by shadow boundary, not by DOM-tree depth. `:host`
    // selectors continue to match the shadow host regardless of wrapper
    // position.
    const existingChildren = Array.from(shadow.childNodes);
    shadow.appendChild(wrapper);
    for (const child of existingChildren) {
      wrapper.appendChild(child);
    }
  }

  return {
    renderRoot: wrapper,
    styleRoot: shadow,
    isolated: true,
  };
}

/**
 * Wrap an element that already contains SSR'd light-DOM content into a
 * shadow root. Used by the embed loader's hydrate path to convert
 * server-rendered light-DOM markup into shadow-DOM before the runtime
 * attaches event listeners.
 *
 * No-op for `'light'` mode (returns the host unchanged).
 */
export function wrapInShadow(
  host: HTMLElement,
  mode: StyleIsolation,
): HTMLElement {
  if (mode === 'light') return host;
  if (typeof document === 'undefined') return host;

  // Idempotent re-call — return the existing wrapper without re-wrapping.
  const existingShadow = host.shadowRoot;
  if (existingShadow) {
    const existingWrapper = existingShadow.querySelector<HTMLElement>(`.${SHADOW_WRAPPER_CLASS}`);
    if (existingWrapper) return existingWrapper;
  }

  const ssrHtml = host.innerHTML;
  host.innerHTML = '';

  const root = setupIsolationRoot(host, mode);
  root.renderRoot.innerHTML = ssrHtml;
  return root.renderRoot;
}

/**
 * Resolve the styleRoot for an arbitrary element. Used by hydrate when
 * the bootstrap has already wrapped — `target.getRootNode()` returns
 * the ShadowRoot; for non-isolated hosts it returns Document, in which
 * case we fall back to document.head.
 *
 * SSR-safe: ShadowRoot is undefined globally in Deno (deno-dom). When
 * the global is missing, skip the instanceof check and fall through to
 * the owner document's head. Prefer `target.ownerDocument.head` over
 * `globalThis.document.head` so the deno-dom-owned document is reachable
 * server-side.
 */
export function resolveStyleRoot(target: Node): ShadowRoot | HTMLHeadElement {
  if (typeof ShadowRoot !== 'undefined') {
    const root = target.getRootNode();
    if (root instanceof ShadowRoot) return root;
  }
  const ownerDoc = (target as { ownerDocument?: Document }).ownerDocument
    ?? (typeof document !== 'undefined' ? document : null);
  if (!ownerDoc) {
    throw new Error('[@airo-js/core] resolveStyleRoot: no ownerDocument and no global document');
  }
  return ownerDoc.head;
}
