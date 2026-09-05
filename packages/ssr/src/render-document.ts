/**
 * renderDocument — assemble a complete HTML document around a rendered
 * fragment.
 *
 * `renderAppToHTML` and `renderAppWithPublication` return a FRAGMENT, which
 * is correct: a host embedding a widget into its own page needs a blob it
 * can drop into an existing `<head>`-or-`<body>` slot, and the
 * `airo-ssr="hydrate"` path depends on exactly that. But an app that owns
 * its whole URL — a root-mounted site — needs the bytes a browser parses,
 * and until 0.9.0 every consumer hand-wrote them. There were four
 * hand-rolled `<!doctype html>` templates in this repo alone, plus three
 * private copies of `escapeHtml`.
 *
 * ## Composes, does not wrap
 *
 * This takes a `body` string rather than a cartridge. Three reasons, and
 * the first is decisive:
 *
 *   1. Not every document has a cartridge. A landing page, a 404, an
 *      error shell — all want the same shell with no snapshot in sight.
 *      A wrapper over `renderAppWithPublication` cannot serve them.
 *   2. The fragment seam is load-bearing and documented. Wrapping would
 *      either kill it or duplicate it behind a flag.
 *   3. Composition keeps this function synchronous, pure, and free of any
 *      `Document` — no linkedom, no deps, no DOM globals. It is a string
 *      function, which is the only way to actually prove the package's
 *      runtime-agnostic claim (its tests run under the node environment).
 *
 * Typical use:
 *
 *   const result = await renderAppWithPublication({ ... });
 *   return new Response(renderDocument({
 *     head: {
 *       lang: publicationCtx.locale,
 *       title: snapshot.title,
 *       ...headFromPublication(result.adapterResults),
 *     },
 *     body: result.html,
 *   }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
 *
 * ## Framework-authored defaults: correctness only, never taste
 *
 * The framework is headless — it authors no UI, no CSS, and no visual
 * defaults. Applied tag by tag, the test is whether a default expresses
 * *correctness* or *policy*:
 *
 *   - `<!doctype html>` — always, not configurable. Quirks mode is never
 *     wanted, and emitting it is the entire point of this function.
 *   - `<meta charset>` — DEFAULTED to utf-8, `charset: false` to omit.
 *     This is the framework's own correctness: it produces the byte
 *     stream, so without an encoding declaration a sniffing parser can
 *     misread the very entities `escapeHtml` emitted, which would make
 *     the escaping unsound. The one framework-authored tag, with an
 *     escape hatch for callers who declare encoding over HTTP.
 *   - `viewport` — NO DEFAULT, EVER. `width=device-width, initial-scale=1`
 *     is a responsive-design policy decision. Native webviews, print
 *     targets and fixed-width legacy hosts all want something else or
 *     nothing. Hard-coding it would be authoring a visual default — the
 *     exact category the 0.4 headless strip removed.
 *   - `lang` — REQUIRED, no default. It is data the framework cannot
 *     invent, and `"en"` is a lie for most of the world. A silently wrong
 *     `lang` degrades screen readers, hyphenation and hreflang.
 *
 * ## Verbatim content and the breakout guard
 *
 * `inlineStyles`, inline `scripts[].content` and `raw` are emitted
 * VERBATIM — no escaping, no transform, no prefixing, no scoping. That is
 * what makes them caller passthrough rather than framework-authored: the
 * framework ships zero CSS (`inlineStyles` defaults to `[]`) and never
 * touches what you hand it.
 *
 * Escaping them would corrupt CSS and JS, so instead a substring that
 * would close the element early (`</style`, `</script`) THROWS. Loud
 * failure beats silent mangling, and it is the same class of guard as the
 * `<` escape in `buildJsonLdScript`.
 *
 * NOTE `inlineStyles` are document-scoped: they do NOT cross a shadow
 * boundary. A view rendered into declarative shadow DOM needs its CSS
 * inside the template, not here.
 */

import { escapeAttr, escapeHtml } from '@airo-js/core';

import { buildJsonLdScript } from './build-json-ld-script.js';

/** One `<meta>` tag. Exactly one of name / property / httpEquiv is emitted, in that order of precedence. */
export interface MetaTag {
  name?: string;
  property?: string;
  httpEquiv?: string;
  content: string;
}

/** One `<link>` tag. `attrs` carries anything else (`hreflang`, `type`, `sizes`, `crossorigin`, `media`). */
export interface LinkTag {
  rel: string;
  href: string;
  attrs?: Readonly<Record<string, string>>;
}

/** One `<script>` tag. Inline `content` is emitted VERBATIM — never build it from untrusted input. */
export interface ScriptTag {
  src?: string;
  content?: string;
  type?: string;
  defer?: boolean;
  async?: boolean;
  nonce?: string;
  attrs?: Readonly<Record<string, string>>;
}

export interface DocumentHead {
  /**
   * REQUIRED. `<html lang>`. No default — see the docblock; the framework
   * cannot invent a locale and a wrong one is worse than a missing one.
   */
  lang: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  /** Defaults to `'utf-8'`. Pass `false` to omit (e.g. encoding declared by HTTP header). */
  charset?: string | false;
  title?: string;
  /** NO default. Omitted → no viewport tag at all. See the docblock. */
  viewport?: string;
  canonical?: string;
  base?: string;
  meta?: readonly MetaTag[];
  links?: readonly LinkTag[];
  /** `'og:title'` → value. Emitted as `<meta property>` — the OpenGraph spec form. */
  openGraph?: Readonly<Record<string, string>>;
  /** `'twitter:card'` → value. Emitted as `<meta name>` — the Twitter spec form. */
  twitter?: Readonly<Record<string, string>>;
  /**
   * Extra JSON-LD payloads. Do NOT re-add blocks the body already carries:
   * `renderAppWithPublication` inlines its adapters' JSON-LD into the
   * fragment, so folding them in here too emits every block twice.
   * `headFromPublication` excludes them by default for this reason.
   */
  jsonLd?: readonly unknown[];
  /** Caller-supplied CSS, emitted verbatim. Framework default is `[]` — always. */
  inlineStyles?: readonly string[];
  scripts?: readonly ScriptTag[];
  /** Verbatim head HTML, emitted LAST so a caller can override anything above. */
  raw?: string;
}

export interface RenderDocumentOptions {
  head: DocumentHead;
  /** Body inner HTML — typically `renderAppWithPublication().html`. Emitted verbatim. */
  body: string;
  htmlAttrs?: Readonly<Record<string, string>>;
  bodyAttrs?: Readonly<Record<string, string>>;
  /** Appended after `body`, in order. */
  bodyScripts?: readonly ScriptTag[];
  /** Separator between emitted lines. Default `'\n'`; pass `''` for single-line output. */
  newline?: string;
}

/**
 * Reject content that would close its own element early. Escaping is not
 * an option inside `<style>` / `<script>` — it would corrupt the CSS or
 * JS — so a breakout attempt is a hard error rather than silent mangling.
 */
function assertNoBreakout(content: string, tag: 'style' | 'script'): void {
  if (new RegExp(`</\\s*${tag}`, 'i').test(content)) {
    throw new Error(
      `[@airo-js/ssr] renderDocument: inline <${tag}> content contains a closing "</${tag}" sequence, which would end the element early. This content is emitted verbatim (escaping it would corrupt the ${
        tag === 'style' ? 'CSS' : 'JS'
      }), so it is rejected instead. Move it to an external file, or split the sequence at the source.`,
    );
  }
}

/** Serialise an attribute bag. Values are attribute-escaped; keys are trusted (author-supplied). */
function attrs(bag: Readonly<Record<string, string>> | undefined): string {
  if (!bag) return '';
  return Object.entries(bag)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
}

function metaTag(tag: MetaTag): string {
  const key = tag.name
    ? `name="${escapeAttr(tag.name)}"`
    : tag.property
      ? `property="${escapeAttr(tag.property)}"`
      : tag.httpEquiv
        ? `http-equiv="${escapeAttr(tag.httpEquiv)}"`
        : '';
  if (!key) return '';
  return `<meta ${key} content="${escapeAttr(tag.content)}">`;
}

function linkTag(tag: LinkTag): string {
  return `<link rel="${escapeAttr(tag.rel)}" href="${escapeAttr(tag.href)}"${attrs(tag.attrs)}>`;
}

function scriptTag(tag: ScriptTag): string {
  const parts: string[] = [];
  if (tag.type) parts.push(` type="${escapeAttr(tag.type)}"`);
  if (tag.src) parts.push(` src="${escapeAttr(tag.src)}"`);
  if (tag.defer) parts.push(' defer');
  if (tag.async) parts.push(' async');
  if (tag.nonce) parts.push(` nonce="${escapeAttr(tag.nonce)}"`);
  parts.push(attrs(tag.attrs));
  // Caller passthrough — the framework authors no JS. Guarded, not escaped.
  const body = tag.content ?? '';
  if (body) assertNoBreakout(body, 'script');
  return `<script${parts.join('')}>${body}</script>`;
}

/**
 * Assemble a complete HTML document. Pure and synchronous — no `Document`,
 * no DOM globals, no I/O.
 *
 * Head emission order is fixed and stable: charset → base → viewport →
 * title → meta → canonical → links → openGraph → twitter → jsonLd →
 * inlineStyles → scripts → raw. Charset goes first so it lands inside the
 * first 1024 bytes, where sniffing parsers stop looking; `raw` goes last
 * so it wins.
 *
 * @throws if inline `<style>` / `<script>` content would close its element early.
 */
export function renderDocument(opts: RenderDocumentOptions): string {
  const head = opts.head;
  const nl = opts.newline ?? '\n';
  const out: string[] = [];

  const charset = head.charset === undefined ? 'utf-8' : head.charset;
  if (charset !== false) out.push(`<meta charset="${escapeAttr(charset)}">`);
  if (head.base) out.push(`<base href="${escapeAttr(head.base)}">`);
  if (head.viewport) out.push(`<meta name="viewport" content="${escapeAttr(head.viewport)}">`);
  if (head.title !== undefined) out.push(`<title>${escapeHtml(head.title)}</title>`);

  for (const tag of head.meta ?? []) {
    const rendered = metaTag(tag);
    if (rendered) out.push(rendered);
  }

  if (head.canonical) {
    out.push(`<link rel="canonical" href="${escapeAttr(head.canonical)}">`);
  }
  for (const tag of head.links ?? []) out.push(linkTag(tag));

  // OpenGraph uses `property=`, Twitter uses `name=`. That is a real spec
  // difference every hand-rolled shell in this repo got wrong, and it is
  // why these are two fields rather than one meta[] — the FIELD is the
  // routing decision. Never re-derive it by sniffing the key prefix.
  for (const [k, v] of Object.entries(head.openGraph ?? {})) {
    out.push(`<meta property="${escapeAttr(k)}" content="${escapeAttr(v)}">`);
  }
  for (const [k, v] of Object.entries(head.twitter ?? {})) {
    out.push(`<meta name="${escapeAttr(k)}" content="${escapeAttr(v)}">`);
  }

  for (const payload of head.jsonLd ?? []) out.push(buildJsonLdScript(payload));

  // Caller passthrough — framework authors no CSS. Default is [], so a
  // document with no caller styles contains no <style> at all.
  for (const css of head.inlineStyles ?? []) {
    assertNoBreakout(css, 'style');
    out.push(`<style>${css}</style>`);
  }

  for (const tag of head.scripts ?? []) out.push(scriptTag(tag));
  if (head.raw) out.push(head.raw);

  const htmlAttr = ` lang="${escapeAttr(head.lang)}"${
    head.dir ? ` dir="${escapeAttr(head.dir)}"` : ''
  }${attrs(opts.htmlAttrs)}`;

  const bodyParts = [opts.body];
  for (const tag of opts.bodyScripts ?? []) bodyParts.push(scriptTag(tag));

  return [
    '<!doctype html>',
    `<html${htmlAttr}>`,
    '<head>',
    ...out,
    '</head>',
    `<body${attrs(opts.bodyAttrs)}>`,
    ...bodyParts,
    '</body>',
    '</html>',
  ].join(nl);
}
