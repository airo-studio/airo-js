/**
 * JSON-LD script-tag serialisation — extracted so there is exactly ONE
 * emitter in the package.
 *
 * From 0.9.0 two call sites need this: `renderAppWithPublication` inlines
 * adapter output ahead of the widget markup, and `renderDocument` emits
 * `head.jsonLd` into the document head. Two copies of an escaping routine
 * become the XSS hole the day someone "improves" one of them, so both call
 * this and a test asserts they produce byte-identical output for the same
 * payload — the same drift-impossible-by-construction discipline
 * `defineSSRSafeRenderer` applies to render/hydrate.
 */

/**
 * Serialise a JSON-LD payload into a `<script type="application/ld+json">`
 * tag. Escapes the closing-script sequence so an attacker controlling a
 * snapshot field can't break out of the script context.
 *
 * Note: `<` is the JSON-safe encoding for `<`. JSON-LD payloads are
 * data only (no executable JS), so the only XSS surface is the literal
 * `</script>` substring in a string field. Replacing the `<` defeats it.
 *
 * This is deliberately NOT `escapeHtml`: inside a `<script>` element the
 * content is CDATA-like, so HTML entities would corrupt the JSON rather
 * than protect it. Escaping rules follow the enclosing context, and this
 * context is a script body, not markup.
 */
export function buildJsonLdScript(payload: unknown): string {
  const safe = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${safe}</script>`;
}
