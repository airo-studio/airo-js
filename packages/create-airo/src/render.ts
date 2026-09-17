/**
 * Placeholder substitution for template files.
 *
 * Placeholders are `__UPPER_SNAKE__`, not `{{mustache}}`, so a template file
 * stays plausible on disk: `__PKG_NAME__` is a valid TypeScript identifier and
 * `"^__V_CORE__"` is a valid JSON string. A template can be opened in an
 * editor and a template package.json can be `JSON.parse`d in a test.
 *
 * An unknown placeholder THROWS. Without that, a typo ships verbatim into the
 * user's project, where it fails later and somewhere unrelated.
 *
 * One pass: a substituted value is never rescanned. That matters because some
 * values are shaped like placeholders themselves — a mailbox name is
 * `__AIRO_MY_APP_PAGES__`.
 *
 * Consequence: a template cannot contain a literal `__UPPER__` token of its
 * own. None does today. If one ever needs to, add an escape here rather than
 * working around it in the template.
 */

const TOKEN = /__([A-Z][A-Z0-9_]*)__/g;

export class TemplateError extends Error {
  override name = 'TemplateError';
}

export function render(text: string, vars: Readonly<Record<string, string>>, file?: string): string {
  return text.replace(TOKEN, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined) {
      throw new TemplateError(`Unknown template placeholder ${whole}${file ? ` in ${file}` : ''}.`);
    }
    return value;
  });
}

/**
 * Which files get substituted. Everything else is copied byte-for-byte, so a
 * binary asset can never be mangled.
 */
const RENDERED_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.json', '.md', '.html', '.css']);
const RENDERED_NAMES = new Set(['_gitignore']);

export function isRendered(fileName: string): boolean {
  if (RENDERED_NAMES.has(fileName)) return true;
  const dot = fileName.lastIndexOf('.');
  return dot > 0 && RENDERED_EXTENSIONS.has(fileName.slice(dot));
}
