/**
 * The one naming contract between `./build` and `./runtime`.
 *
 * Lynx parses attribute selectors and type selectors but never matches them:
 * a `[hidden]` rule, an `[aria-pressed="true"]` rule or an `h1` rule styles
 * nothing on device. So the build rewrites each such selector to a class, and
 * the runtime puts that class on every element whose attributes or tag would
 * have matched. Both sides call the functions in this file and nothing else,
 * so the class a rule targets and the class an element carries cannot drift.
 *
 * The encoding is injective: two different (name, value) pairs never produce
 * the same class.
 *
 *   - Names are lowercased (HTML attribute names are case-insensitive). Every
 *     character outside `[a-z0-9-]` becomes `_<hex>_`, and so does a `-` that
 *     follows another `-`, so an encoded name never contains `--`.
 *   - Values keep their case (attribute values are case-sensitive). Every
 *     character outside `[A-Za-z0-9]` becomes `_<hex>_`, `-` and `_` included,
 *     so an encoded value contains no `-` at all.
 *   - `--` therefore appears at most once, between name and value.
 *
 * A value is mirrored only when it is a short token: at most
 * {@link MAX_MIRRORED_VALUE} characters and no whitespace. URLs, sentences and
 * JSON in attributes never become classes on device, and a selector that
 * tests for one is reported as unsupported at build time rather than
 * silently never matching.
 */

/** Longest attribute value that becomes a class. Longer values are presence-only. */
export const MAX_MIRRORED_VALUE = 48;

/** Class every Lynx page element carries: the target of rewritten `html`, `body` rules. */
export const PAGE_CLASS = 'airo-lynx-page';

/** Class the page element carries when the host passed `colorScheme: 'dark'`. */
export const DARK_CLASS = 'airo-lynx-dark';

/**
 * Class of the scroller the mount puts every page in: the device's stand-in
 * for the browser viewport, which scrolls when the document is taller.
 */
export const VIEWPORT_CLASS = 'airo-lynx-viewport';

/** Attributes the runtime never mirrors: they are already classes, ids or inline styles. */
export const UNMIRRORED_ATTRIBUTES: ReadonlySet<string> = new Set(['class', 'id', 'style']);

const hex = (char: string): string => `_${char.codePointAt(0)!.toString(16)}_`;

function encodeName(name: string): string {
  let out = '';
  let prev = '';
  for (const char of name.toLowerCase()) {
    if (char === '-') out += prev === '-' ? hex(char) : char;
    else out += /[a-z0-9]/.test(char) ? char : hex(char);
    prev = char;
  }
  return out;
}

function encodeValue(value: string): string {
  let out = '';
  for (const char of value) out += /[A-Za-z0-9]/.test(char) ? char : hex(char);
  return out;
}

/** True when `value` is short enough, and whitespace-free, to become a class. */
export function isMirroredValue(value: string): boolean {
  return value.length <= MAX_MIRRORED_VALUE && !/\s/.test(value);
}

/**
 * The class for an attribute's presence (`[name]`), or for one of its values
 * (`[name="value"]`). Returns `null` for a value that is not mirrored.
 *
 * ```ts
 * attrClass('hidden')                    // 'a-hidden'
 * attrClass('aria-pressed', 'true')      // 'a-aria-pressed--true'
 * attrClass('data-state', 'in-progress') // 'a-data-state--in_2d_progress'
 * ```
 */
export function attrClass(name: string): string;
export function attrClass(name: string, value: string): string | null;
export function attrClass(name: string, value?: string): string | null {
  const base = `a-${encodeName(name)}`;
  if (value === undefined) return base;
  return isMirroredValue(value) ? `${base}--${encodeValue(value)}` : null;
}

/** The class standing in for an HTML type selector: `h1` → `tag-h1`. */
export function tagClass(tag: string): string {
  return `tag-${encodeName(tag)}`;
}
