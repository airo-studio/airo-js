/**
 * Checks on the templates as they ship.
 *
 * The most important one is the `npm pack` test. A template file that does
 * not make it into the tarball breaks every user of that template, and
 * nothing local shows it: the file is right there on disk. It catches a
 * directory named `dist` or `build` (the root `.gitignore` drops those at any
 * depth), a dotfile npm strips, and a `files` array someone edited.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { deriveNames, nameVars } from '../src/names.js';
import { planScaffold, renderScaffold, writeScaffold } from '../src/scaffold.js';
import { TEMPLATES } from '../src/templates.js';
import { targetLine, versionVars } from '../src/versions.js';
import { tempDir } from './helpers.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = join(PKG_ROOT, 'templates');

/** Every file under `dir`, relative, `/`-separated. */
function walk(dir: string, rel = ''): string[] {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(dir, path) : [path];
  });
}

describe('the template registry', () => {
  test('lists exactly the directories under templates/', () => {
    const dirs = existsSync(TEMPLATES_ROOT)
      ? readdirSync(TEMPLATES_ROOT, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : [];
    expect(TEMPLATES.map((t) => t.name).sort()).toEqual(dirs.sort());
  });

  test('every entry has a description and at least one next step', () => {
    for (const t of TEMPLATES) {
      expect(t.description, t.name).not.toBe('');
      expect(t.nextScripts.length, t.name).toBeGreaterThan(0);
    }
  });
});

describe('template file names', () => {
  test('no path segment is one the root .gitignore drops at any depth', () => {
    for (const path of walk(TEMPLATES_ROOT)) {
      for (const segment of path.split('/')) {
        expect(['dist', 'build', 'node_modules'], path).not.toContain(segment);
      }
    }
  });

  test('dotfiles npm strips are stored under their underscore names', () => {
    for (const path of walk(TEMPLATES_ROOT)) {
      const name = path.split('/').pop();
      expect(['.gitignore', '.npmignore', '.npmrc'], path).not.toContain(name);
    }
  });
});

describe('the published tarball', () => {
  test('npm pack ships every template file', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [manifest] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(manifest?.files.map((f) => f.path));

    expect(packed.has('package.json')).toBe(true);
    expect(packed.has('README.md')).toBe(true);
    for (const rel of walk(TEMPLATES_ROOT)) {
      expect(packed.has(`templates/${rel}`), `templates/${rel} is missing from the tarball`).toBe(true);
    }
  });
});

describe('every shipped template scaffolds cleanly', () => {
  // vitest refuses an empty suite; a build with no templates is legal.
  if (TEMPLATES.length === 0) test.todo('this build ships no templates');
  for (const template of TEMPLATES) {
    test(template.name, () => {
      const { dir, cleanup } = tempDir();
      try {
        const names = deriveNames('probe-app', dir);
        const vars = {
          ...nameVars(names),
          ...versionVars(),
          CREATE_AIRO_VERSION: '0.0.0-test',
          TEMPLATE: template.name,
          TARGET_LINE: targetLine(),
        };
        const files = renderScaffold(planScaffold(join(TEMPLATES_ROOT, template.name)), vars);
        writeScaffold(files, names.targetDir);

        for (const file of files) {
          if (file.content === null) continue;
          for (const key of Object.keys(vars)) {
            expect(file.content, `${file.path} still contains __${key}__`).not.toContain(`__${key}__`);
          }
          if (file.path.endsWith('package.json')) {
            expect(() => JSON.parse(file.content ?? ''), file.path).not.toThrow();
            expect(file.content, `${file.path} has a workspace: range`).not.toContain('workspace:');
          }
        }

        const pkg = JSON.parse(readFileSync(join(names.targetDir, 'package.json'), 'utf8')) as {
          name: string;
        };
        expect(pkg.name).toBe('probe-app');
        expect(existsSync(join(names.targetDir, '.gitignore'))).toBe(true);
      } finally {
        cleanup();
      }
    });
  }
});
