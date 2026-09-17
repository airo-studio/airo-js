/**
 * The write engine: list a template's files, render them, write them.
 *
 * Rendering and writing are separate steps on purpose. `renderScaffold`
 * substitutes every file in memory first, so an unknown placeholder throws
 * before anything touches the disk — a half-written project directory is the
 * one outcome worse than an error.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRendered, render } from './render.js';

/**
 * `templates/` sits beside both `src/` and `dist/`, so this resolves the same
 * from the TypeScript source under test, the local build, and the installed
 * package.
 */
export const DEFAULT_TEMPLATES_ROOT = fileURLToPath(new URL('../templates/', import.meta.url));

/**
 * npm strips a literal `.gitignore` from published tarballs, so templates
 * store it as `_gitignore` and it is renamed on the way out.
 */
const RENAME: Readonly<Record<string, string>> = { _gitignore: '.gitignore' };

/** Never copied out of a template, even if one ends up there locally. */
const SKIP = new Set(['node_modules', 'dist', '.DS_Store']);

/** A target directory holding only these still counts as empty. */
const IGNORABLE_IN_TARGET = new Set(['.git', '.DS_Store']);

export interface PlannedFile {
  /** Absolute path inside the template. */
  source: string;
  /** Path relative to the project root, `/`-separated, after renames. */
  path: string;
  /** Whether placeholders are substituted, or the bytes copied as-is. */
  rendered: boolean;
}

export interface RenderedFile extends PlannedFile {
  /** Substituted text for rendered files; `null` means copy `source`. */
  content: string | null;
}

export function planScaffold(templateDir: string): PlannedFile[] {
  if (!existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }
  const files: PlannedFile[] = [];
  collect(templateDir, '', files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function collect(root: string, rel: string, out: PlannedFile[]): void {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collect(root, relPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const outName = RENAME[entry.name] ?? entry.name;
    out.push({
      source: join(root, relPath),
      path: rel ? `${rel}/${outName}` : outName,
      rendered: isRendered(entry.name),
    });
  }
}

export function renderScaffold(
  files: readonly PlannedFile[],
  vars: Readonly<Record<string, string>>,
): RenderedFile[] {
  return files.map((file) => ({
    ...file,
    content: file.rendered ? render(readFileSync(file.source, 'utf8'), vars, file.path) : null,
  }));
}

export function writeScaffold(files: readonly RenderedFile[], targetDir: string): void {
  for (const file of files) {
    const dest = join(targetDir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (file.content === null) copyFileSync(file.source, dest);
    else writeFileSync(dest, file.content);
  }
}

/**
 * True when `dir` does not exist or holds nothing that matters. A file at
 * that path counts as not empty — there is something in the way.
 */
export function isEmptyTarget(dir: string): boolean {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  return readdirSync(dir).every((name) => IGNORABLE_IN_TARGET.has(name));
}
