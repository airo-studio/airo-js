/**
 * The version map is hand-maintained, so this is what keeps it honest.
 *
 * Without it the CLI can publish templates naming a version that does not
 * exist on npm — a failure on every user's first `npm install`, and nothing
 * in this repo would notice.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AIRO_VERSIONS, targetLine, versionToken, versionVars } from '../src/versions.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_PACKAGES = join(PKG_ROOT, '..');
const TEMPLATES_ROOT = join(PKG_ROOT, 'templates');

/**
 * A published @airo-js package no template should ever name goes here, with
 * a reason. Empty today: every package is usable from some starter.
 */
const NOT_SHIPPED_TO_TEMPLATES = new Set<string>();

const DEP_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function templateManifests(dir = TEMPLATES_ROOT): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : templateManifests(path);
    return entry.name === 'package.json' ? [path] : [];
  });
}

describe('AIRO_VERSIONS', () => {
  test('every entry equals that package’s version in this repo', () => {
    for (const [pkg, version] of Object.entries(AIRO_VERSIONS)) {
      const manifest = join(REPO_PACKAGES, pkg.replace('@airo-js/', ''), 'package.json');
      expect({ pkg, version }).toEqual({ pkg, version: readManifest(manifest).version });
    }
  });

  test('every published @airo-js package in this repo is mapped, or excluded with a reason', () => {
    const published = readdirSync(REPO_PACKAGES)
      .map((dir) => join(REPO_PACKAGES, dir, 'package.json'))
      .filter(existsSync)
      .map(readManifest)
      .filter((m) => m.name.startsWith('@airo-js/') && m.private !== true)
      .map((m) => m.name);

    expect(published.length).toBeGreaterThan(0);
    for (const name of published) {
      expect(name in AIRO_VERSIONS || NOT_SHIPPED_TO_TEMPLATES.has(name), name).toBe(true);
    }
  });

  test('templates name @airo-js versions only through the placeholder', () => {
    for (const path of templateManifests()) {
      const manifest = readManifest(path);
      for (const block of DEP_BLOCKS) {
        for (const [name, spec] of Object.entries(manifest[block] ?? {})) {
          if (!name.startsWith('@airo-js/')) continue;
          const where = `${relative(PKG_ROOT, path)} ${block}.${name}`;
          expect(name in AIRO_VERSIONS, `${where} is not in AIRO_VERSIONS`).toBe(true);
          expect(spec, where).toBe(`^__${versionToken(name)}__`);
        }
      }
    }
  });
});

describe('version helpers', () => {
  test('versionToken turns a package into its placeholder name', () => {
    expect(versionToken('@airo-js/core')).toBe('V_CORE');
    expect(versionToken('@airo-js/cartridge-kit')).toBe('V_CARTRIDGE_KIT');
  });

  test('versionVars covers every mapped package', () => {
    const vars = versionVars();
    expect(Object.keys(vars)).toHaveLength(Object.keys(AIRO_VERSIONS).length);
    expect(vars.V_RUNTIME).toBe(AIRO_VERSIONS['@airo-js/runtime']);
  });

  test('targetLine is the major.minor the framework packages share', () => {
    expect(targetLine()).toMatch(/^\d+\.\d+$/);
    expect(AIRO_VERSIONS['@airo-js/core'].startsWith(`${targetLine()}.`)).toBe(true);
  });
});
