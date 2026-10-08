/**
 * A strict HTML fragment parser for the Lynx main thread.
 *
 * Every page reaches the device as server-rendered HTML, and hydrate code
 * writes more through `innerHTML` and `insertAdjacentHTML`. A full HTML
 * parser would bring entity tables and error recovery onto the thread that
 * draws the screen; this parser instead accepts exactly what airo-js
 * templates produce and refuses the rest by name:
 *
 *   - elements, attributes (quoted, unquoted, boolean) and text;
 *   - the HTML void elements, with or without `/>`;
 *   - `<script>` / `<style>` as raw text and `<textarea>` / `<title>` as
 *     escapable raw text, as the HTML parser treats them;
 *   - `<svg>` subtrees as foreign content: case kept, `/>` closes;
 *   - comments, skipped;
 *   - the five entities `escapeHtml` writes (`&amp;` `&lt;` `&gt;` `&quot;`
 *     `&#39;`) and numeric references.
 *
 * Anything else — a named entity such as `&nbsp;`, an end tag that does not
 * close the open element, an unclosed element, a `<` that does not start a
 * tag — throws an `HtmlParseError` naming what and where. A browser would
 * recover from each of those; recovering here would mean a device tree that
 * silently differs from the browser's, so it does not. A conformance test
 * holds this parser's trees equal to a browser-grade parser's on real pages.
 */

interface ParsedElement {
  kind: 'element';
  /** Lowercase for HTML; as written inside `<svg>`. */
  tag: string;
  /** In source order. Names lowercase for HTML, as written inside `<svg>`. */
  attrs: [name: string, value: string][];
  children: ParsedNode[];
  /** True for `<svg>` and everything inside it. */
  foreign: boolean;
}

interface ParsedText {
  kind: 'text';
  text: string;
}

export type ParsedNode = ParsedElement | ParsedText;

export class HtmlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`[@airo-js/lynx] HTML parse error at ${line}:${column}: ${message}`);
    this.name = 'HtmlParseError';
  }
}

/** HTML void elements (HTML Living Standard §13.1.2). */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const RAW_TEXT = new Set(['script', 'style']);
const ESCAPABLE_RAW_TEXT = new Set(['textarea', 'title']);

/** The entities `escapeHtml` in @airo-js/core writes, and nothing else. */
const NAMED: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
});

const TAG_NAME = /[A-Za-z][A-Za-z0-9:-]*/y;
const ATTR_NAME = /[^\s"'>/=]+/y;
const UNQUOTED = /[^\s"'=<>`]+/y;
const WS = /\s*/y;

export function tokenize(html: string): ParsedNode[] {
  let pos = 0;

  const where = (at: number): [number, number] => {
    const before = html.slice(0, at);
    const line = before.split('\n').length;
    return [line, at - before.lastIndexOf('\n')];
  };
  const fail = (message: string, at = pos): never => {
    const [line, column] = where(at);
    throw new HtmlParseError(message, line, column);
  };

  const decode = (text: string, offset: number): string =>
    text.replace(/&([^;\s&<]*)(;?)/g, (whole, body: string, semi: string, index: number) => {
      if (body === '' || !/^[A-Za-z0-9#]/.test(body)) return whole;
      if (!semi) fail(`"&${body}" is not a complete character reference`, offset + index);
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const digits = body.slice(hex ? 2 : 1);
        const ok = hex ? /^[0-9a-fA-F]+$/.test(digits) : /^[0-9]+$/.test(digits);
        const code = ok ? Number.parseInt(digits, hex ? 16 : 10) : Number.NaN;
        if (!ok || code > 0x10ffff || code === 0) fail(`"&${body};" is not a valid numeric reference`, offset + index);
        return String.fromCodePoint(code);
      }
      const char = NAMED[body];
      if (char === undefined) {
        fail(
          `the entity "&${body};" is not one escapeHtml writes; send the character itself or a numeric reference`,
          offset + index,
        );
      }
      return char!;
    });

  const match = (re: RegExp): string | null => {
    re.lastIndex = pos;
    const m = re.exec(html);
    if (!m) return null;
    pos = re.lastIndex;
    return m[0];
  };
  const skipWs = (): void => {
    match(WS);
  };

  interface Open {
    el: ParsedElement;
    at: number;
  }
  const root: ParsedElement = { kind: 'element', tag: '#fragment', attrs: [], children: [], foreign: false };
  const stack: Open[] = [{ el: root, at: 0 }];
  const top = (): Open => stack[stack.length - 1]!;

  const pushText = (text: string): void => {
    if (!text) return;
    const children = top().el.children;
    const last = children[children.length - 1];
    if (last?.kind === 'text') last.text += text;
    else children.push({ kind: 'text', text });
  };

  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      pushText(decode(html.slice(pos), pos));
      pos = html.length;
      break;
    }
    pushText(decode(html.slice(pos, lt), pos));
    pos = lt;

    if (html.startsWith('<!--', pos)) {
      const end = html.indexOf('-->', pos + 4);
      if (end === -1) fail('unclosed comment');
      pos = end + 3;
      continue;
    }
    if (html.startsWith('<!', pos) || html.startsWith('<?', pos)) {
      fail('doctype, CDATA and processing instructions are not allowed in a fragment');
    }

    if (html.startsWith('</', pos)) {
      const at = pos;
      pos += 2;
      const raw = match(TAG_NAME) ?? fail('an end tag needs a name');
      skipWs();
      if (html[pos] !== '>') fail(`malformed end tag </${raw}`);
      pos++;
      const open = top();
      const name = open.el.foreign ? raw : raw.toLowerCase();
      if (VOID_ELEMENTS.has(name) && !open.el.foreign) fail(`</${name}> closes a void element, which has no end tag`, at);
      if (open.el === root) fail(`</${name}> has no open element to close`, at);
      const expected = open.el.foreign ? open.el.tag : open.el.tag.toLowerCase();
      if ((open.el.foreign ? name : name.toLowerCase()) !== expected) {
        fail(`</${name}> does not close the open <${open.el.tag}>`, at);
      }
      stack.pop();
      continue;
    }

    // Start tag.
    const at = pos;
    pos++;
    const raw = match(TAG_NAME);
    if (raw === null) fail('"<" that does not start a tag; escape it as &lt;', at);
    const foreign = top().el.foreign || raw!.toLowerCase() === 'svg';
    const tag = foreign ? raw! : raw!.toLowerCase();
    const el: ParsedElement = { kind: 'element', tag, attrs: [], children: [], foreign };
    const seen = new Set<string>();
    let selfClosing = false;
    for (;;) {
      skipWs();
      if (pos >= html.length) fail(`unclosed start tag <${tag}`, at);
      if (html[pos] === '>') {
        pos++;
        break;
      }
      if (html.startsWith('/>', pos)) {
        pos += 2;
        selfClosing = true;
        break;
      }
      const nameAt = pos;
      const rawName = match(ATTR_NAME) ?? fail(`malformed attribute in <${tag}>`);
      const name = foreign ? rawName : rawName.toLowerCase();
      if (seen.has(name.toLowerCase())) fail(`duplicate attribute "${name}" on <${tag}>`, nameAt);
      seen.add(name.toLowerCase());
      skipWs();
      let value = '';
      if (html[pos] === '=') {
        pos++;
        skipWs();
        const quote = html[pos];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, pos + 1);
          if (end === -1) fail(`unclosed attribute value for "${name}" on <${tag}>`);
          value = decode(html.slice(pos + 1, end), pos + 1);
          pos = end + 1;
        } else {
          const valueAt = pos;
          value = decode(match(UNQUOTED) ?? fail(`missing value for "${name}" on <${tag}>`), valueAt);
        }
      }
      el.attrs.push([name, value]);
    }

    top().el.children.push(el);
    const isVoid = !foreign && VOID_ELEMENTS.has(tag);
    if (isVoid) continue;
    if (selfClosing) {
      if (foreign) continue;
      fail(`<${tag}/> self-closes a non-void HTML element, which a browser would leave open`, at);
    }

    if (!foreign && (RAW_TEXT.has(tag) || ESCAPABLE_RAW_TEXT.has(tag))) {
      const close = new RegExp(`</${tag}\\s*>`, 'ig');
      close.lastIndex = pos;
      const m = close.exec(html);
      if (!m) fail(`unclosed <${tag}>`, at);
      const body = html.slice(pos, m!.index);
      const text = RAW_TEXT.has(tag) ? body : decode(body, pos);
      if (text) el.children.push({ kind: 'text', text });
      pos = m!.index + m![0].length;
      continue;
    }
    stack.push({ el, at });
  }

  if (stack.length > 1) {
    const open = top();
    fail(`<${open.el.tag}> is never closed`, open.at);
  }
  return root.children;
}
