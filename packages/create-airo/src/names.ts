/**
 * One project name, turned into every identifier a template needs.
 *
 * The directory is used exactly as given. Everything derived from it is
 * normalised, because each identifier has its own rules and a name that is
 * fine as a folder can be illegal as any of the others.
 */

import { basename, resolve } from 'node:path';

export interface ProjectNames {
  /** Absolute target directory. */
  targetDir: string;
  /** npm package name: lowercase, `[a-z0-9-]`. */
  packageName: string;
  /** Human title for READMEs and page headings: `my-app` → `My App`. */
  displayName: string;
  /** `Cartridge.id`. */
  cartridgeId: string;
  /** `Cartridge.mailboxName`, following `__AIRO_<ID_UPPER>_PAGES__`. */
  mailboxName: string;
  /** A name `customElements.define` will accept. */
  elementName: string;
}

const FALLBACK = 'airo-app';

/**
 * Names the HTML spec reserves; `customElements.define` throws on them even
 * though they contain a hyphen.
 */
const RESERVED_ELEMENT_NAMES = new Set([
  'annotation-xml',
  'color-profile',
  'font-face',
  'font-face-src',
  'font-face-uri',
  'font-face-format',
  'font-face-name',
  'missing-glyph',
]);

export function toSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || FALLBACK;
}

/**
 * A custom element name must start with a lowercase ASCII letter and contain
 * a hyphen, or `customElements.define` throws — at runtime, on the page, long
 * after scaffolding succeeded.
 */
export function toElementName(slug: string): string {
  let name = /^[a-z]/.test(slug) ? slug : `app-${slug}`;
  if (!name.includes('-') || RESERVED_ELEMENT_NAMES.has(name)) name = `${name}-widget`;
  return name;
}

function toDisplayName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function deriveNames(input: string, cwd: string): ProjectNames {
  const targetDir = resolve(cwd, input);
  const slug = toSlug(basename(targetDir));
  return {
    targetDir,
    packageName: slug,
    displayName: toDisplayName(slug),
    cartridgeId: slug,
    mailboxName: `__AIRO_${slug.toUpperCase().replace(/-/g, '_')}_PAGES__`,
    elementName: toElementName(slug),
  };
}

/** The names as template placeholders, ready for `render()`. */
export function nameVars(names: ProjectNames): Record<string, string> {
  return {
    PKG_NAME: names.packageName,
    DISPLAY_NAME: names.displayName,
    CARTRIDGE_ID: names.cartridgeId,
    MAILBOX_NAME: names.mailboxName,
    ELEMENT_NAME: names.elementName,
  };
}
