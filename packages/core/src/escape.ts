/**
 * HTML string escaping — the string-safety half of the env-agnostic seam
 * whose other half is `parse-html.ts`.
 *
 * Cartridge templates build markup as strings (that is the whole point of
 * `defineSSRSafeRenderer`: one pure `template(ctx)` producing byte-identical
 * output on server and client), and `renderDocument` in `@airo-js/ssr`
 * assembles a document the same way. Every one of those call sites
 * interpolates snapshot-derived text into HTML, and until 0.9.0 each
 * re-implemented escaping locally — three copies in the worker example
 * alone, plus two in the README.
 *
 * ## Why both functions escape the same five characters
 *
 * `escapeAttr` is `escapeHtml`'s behaviour under a different NAME, not a
 * different implementation, and the distinction is load-bearing precisely
 * because it is invisible:
 *
 *   - Text context needs `& < >`.
 *   - Attribute context needs those PLUS `"` and `'`, because either one
 *     closes the value and the next character starts a new attribute.
 *     `<meta content="${x}">` with `x` containing `" onload=` is a live
 *     XSS on the host's own origin.
 *
 * Escaping the attribute set everywhere is correct in both contexts, so
 * one implementation serves both. The two exported names exist so a
 * reader at the call site can see which contract is being relied on — and
 * so nobody "optimises" the text path down to three characters and
 * silently breaks every attribute that shares it.
 *
 * **Never narrow `escapeAttr`.** Always quote attribute values.
 *
 * ## What this is not
 *
 * Not a sanitiser. It escapes text for interpolation into markup you are
 * building; it does not clean untrusted HTML you intend to render as
 * HTML. There is no allowlist, no DOM parsing, no URL-scheme checking — a
 * `javascript:` href survives this untouched because it contains none of
 * these five characters. Validate URLs separately.
 *
 * Deliberately no options bag, and it stays that way: cartridge templates
 * import this into browser bundles, so it must stay one regex pass and a
 * frozen lookup table.
 */

/**
 * The attribute-context escape set — a superset of the text-context set,
 * for the reason in the file docblock. Null-prototype so a key like
 * `constructor` cannot reach `Object.prototype`.
 */
const ENTITIES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }),
);

// `String.prototype.replace` resets a global regex's lastIndex itself, so
// this module-level regex is safe to share. Do NOT add a `.test()` fast
// path against it — `test` DOES advance lastIndex, which would make
// escaping depend on how many times it had been called before.
const ESCAPE_RE = /[&<>"']/g;

function escapeEntities(value: string): string {
  return value.replace(ESCAPE_RE, (char) => ENTITIES[char] ?? char);
}

/**
 * Escape a string for interpolation into HTML TEXT content.
 *
 * NOT idempotent — escaping twice double-escapes (`&` → `&amp;` →
 * `&amp;amp;`). Escape once, at the point of interpolation.
 *
 * ```ts
 * root.innerHTML = `<h1>${escapeHtml(data.title)}</h1>`;
 * ```
 */
export function escapeHtml(value: string): string {
  return escapeEntities(value);
}

/**
 * Escape a string for interpolation into a QUOTED HTML attribute value.
 *
 * Same five characters as `escapeHtml` — see the file docblock for why
 * that is correct rather than lazy, and why it must not be narrowed. The
 * value must still be quoted; this does not make an unquoted attribute
 * safe.
 *
 * ```ts
 * `<link rel="canonical" href="${escapeAttr(url)}">`
 * ```
 */
export function escapeAttr(value: string): string {
  return escapeEntities(value);
}
