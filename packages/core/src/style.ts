/**
 * Style isolation strategies — Strategy pattern, three modes.
 *
 *   'none'    — no shadow boundary. Widget renders into the host's light
 *               DOM. Stylesheets target document.head. Compatibility mode
 *               for hosts that need widget styles to flow into the page
 *               (and accept the cost of host CSS leaking in).
 *   'partial' — attach shadow root. Widget styles scoped to the shadow.
 *               Inherited CSS properties (font-family, color, line-height,
 *               letter-spacing) still cascade in from the host page so
 *               the widget adopts the customer's typography.
 *   'full'    — same shadow root, plus `:host { all: initial }` so even
 *               inherited properties are blocked. Total sandbox.
 *
 * Pure DOM. No domain knowledge — drops into any framework that needs a
 * shadow-root strategy abstracted from the renderer.
 */

export type StyleIsolation = 'none' | 'partial' | 'full';

export interface IsolationRoot {
  /** Element renderers paint into. Light-DOM host for 'none', a wrapper
   *  inside the shadow root for 'partial' and 'full'. */
  renderRoot: HTMLElement;
  /** Where stylesheets append. document.head for 'none', the ShadowRoot
   *  otherwise. */
  styleRoot: ShadowRoot | HTMLHeadElement;
  /** True if a shadow boundary was attached. */
  isolated: boolean;
}

const SHADOW_WRAPPER_CLASS = 'airo-shadow-root';
const HOST_RESET_STYLE_ID = 'airo-shadow-host-reset';
const PARTIAL_INHERIT_STYLE_ID = 'airo-shadow-partial-inherit';

/**
 * Attach a shadow root (if mode demands it) and create a render wrapper
 * inside. Idempotent — call twice on the same host and you get the same
 * `renderRoot` back without re-attaching.
 */
export function setupIsolationRoot(
  host: HTMLElement,
  mode: StyleIsolation,
): IsolationRoot {
  if (mode === 'none') {
    return {
      renderRoot: host,
      styleRoot: document.head,
      isolated: false,
    };
  }

  // attachShadow throws on re-attach — re-use an existing shadow root if
  // init runs twice on the same host (hot reload, re-init scenarios).
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  let wrapper = shadow.querySelector<HTMLElement>(`.${SHADOW_WRAPPER_CLASS}`);
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = SHADOW_WRAPPER_CLASS;
    // Pass-through dimensions: without explicit 100% the wrapper
    // collapses to content-based sizing, which breaks `height: 100%`
    // chains inside the widget (e.g. embedded maps go to 0px).
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    shadow.appendChild(wrapper);
  }

  if (mode === 'full') {
    injectHostReset(shadow);
  } else if (mode === 'partial') {
    injectPartialInheritance(shadow);
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
 * No-op for `'none'` mode (returns the host unchanged).
 */
export function wrapInShadow(
  host: HTMLElement,
  mode: StyleIsolation,
): HTMLElement {
  if (mode === 'none') return host;
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
    throw new Error('[@ai-ro/core] resolveStyleRoot: no ownerDocument and no global document');
  }
  return ownerDoc.head;
}

/**
 * 'full' mode: reset every inherited property at the shadow host so
 * customer page CSS can't bleed in through inheritance. `all: initial`
 * covers font, color, line-height, letter-spacing, direction, etc. in
 * one line — Shadow DOM blocks everything else already.
 *
 * `display: block` restores the host's box (initial display is inline).
 */
function injectHostReset(shadow: ShadowRoot): void {
  if (shadow.querySelector(`#${HOST_RESET_STYLE_ID}`)) return;
  const style = document.createElement('style');
  style.id = HOST_RESET_STYLE_ID;
  style.textContent = `:host { all: initial; display: block; }`;
  shadow.appendChild(style);
}

/**
 * 'partial' mode: re-enable inheritance of typography-related properties
 * on the shadow wrapper and its descendants. Widget colors, spacing,
 * layout, themed CSS variables stay as authored; font/line-height/
 * letter-spacing inherit from the host page so the widget adopts the
 * customer's typography.
 *
 * Cartridges that explicitly set these properties on specific components
 * will win specificity over this rule (correct behaviour — `font-family:
 * inherit` is the framework default, component overrides are the
 * cartridge author's intent).
 */
function injectPartialInheritance(shadow: ShadowRoot): void {
  if (shadow.querySelector(`#${PARTIAL_INHERIT_STYLE_ID}`)) return;
  const style = document.createElement('style');
  style.id = PARTIAL_INHERIT_STYLE_ID;
  style.textContent = `
    .${SHADOW_WRAPPER_CLASS},
    .${SHADOW_WRAPPER_CLASS} * {
      font-family: inherit;
      line-height: inherit;
      letter-spacing: inherit;
    }
  `;
  shadow.appendChild(style);
}
