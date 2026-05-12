/**
 * Parse an HTML string into DOM nodes. Env-agnostic seam between the
 * pure-template-render pattern and the framework's DOM-based mount path.
 *
 * Works with any Document — browser, jsdom, happy-dom, linkedom,
 * deno-dom — as long as the platform supports `<template>` (the
 * standard since Chrome 35 / Firefox 22 / Safari 9; all the named
 * polyfills support it).
 *
 * Why `<template>`: parses without scripting context, so `<script>` tags
 * in the input don't execute. Safer than assigning `innerHTML` to a
 * generic element when the input contains feed data.
 *
 * Env resolution order:
 *   1. explicit `doc` parameter
 *   2. `globalThis.document` (browser, or polyfill assigned globally)
 *   3. throw — caller must provide one
 *
 * Recommendation for cartridge authors: pass `host.ownerDocument` when
 * you have a host element. Works inside Shadow DOM, avoids global state,
 * and identifies the right document automatically when rendering across
 * multiple frames or windows.
 */

function resolveDocument(doc?: Document, helperName = 'parseHtml'): Document {
  const resolved = doc ?? (globalThis as { document?: Document }).document;
  if (!resolved) {
    throw new Error(
      `[@airo-js/core] ${helperName}: no Document available. Pass \`doc\` (e.g. \`host.ownerDocument\`) or set \`globalThis.document\` (server-side polyfill).`,
    );
  }
  return resolved;
}

/**
 * Parse a single-root HTML string into a Node. Returns the first child
 * of the parsed `<template>` content. Use for single-element output
 * (the common case for component-shaped HTML).
 *
 * Empty/whitespace-only input returns an empty Text node so callers
 * can append unconditionally without a null check.
 */
export function parseHtml(html: string, doc?: Document): Node {
  const document = resolveDocument(doc, 'parseHtml');
  const tpl = document.createElement('template') as HTMLTemplateElement;
  tpl.innerHTML = html;
  return tpl.content.firstChild ?? document.createTextNode('');
}

/**
 * Parse multi-root HTML into a DocumentFragment. Use when the template
 * produces sibling elements (`<li>...</li><li>...</li>`) and you want
 * to append them all in one call.
 */
export function parseHtmlFragment(html: string, doc?: Document): DocumentFragment {
  const document = resolveDocument(doc, 'parseHtmlFragment');
  const tpl = document.createElement('template') as HTMLTemplateElement;
  tpl.innerHTML = html;
  return tpl.content;
}
