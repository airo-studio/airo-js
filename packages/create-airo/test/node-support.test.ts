import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { isSupportedNode, NODE_ENGINES } from '../src/node-support.js';
import { run } from '../src/run.js';
import { fakeIo, tempDir, writeTree } from './helpers.js';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

function enginesOf(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { engines: { node: string } }).engines.node;
}

describe('the supported Node range', () => {
  test('is the one the site template and this package declare', () => {
    expect(NODE_ENGINES).toBe(enginesOf(join(PKG_ROOT, 'templates/site/package.json')));
    expect(NODE_ENGINES).toBe(enginesOf(join(PKG_ROOT, 'package.json')));
  });

  test.each([
    ['20.19.0', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['22.20.3', true],
    ['23.5.0', false],
    ['24.0.0', true],
    ['26.1.0', true],
    ['nonsense', false],
  ])('%s -> %s', (version, supported) => {
    expect(isSupportedNode(version)).toBe(supported);
  });
});

describe('the preflight', () => {
  let root: string;
  let cleanup: () => void;
  let templatesRoot: string;

  beforeEach(() => {
    ({ dir: root, cleanup } = tempDir());
    templatesRoot = join(root, 'templates');
    writeTree(join(templatesRoot, 'demo'), { 'README.md': '# __DISPLAY_NAME__\n' });
  });
  afterEach(() => cleanup());

  const templates = [{ name: 'demo', description: 'A demo starter', nextScripts: ['dev'] }];

  test('refuses an old Node before writing anything', async () => {
    const io = fakeIo(root);
    expect(await run(['app', '-t', 'demo'], io, { templates, templatesRoot, nodeVersion: '20.19.0' })).toBe(1);
    expect(io.err).toMatch(/Node 20\.19\.0 is too old/);
    expect(io.err).toContain(NODE_ENGINES);
    expect(io.err).toMatch(/Nothing was written/);
    expect(existsSync(join(root, 'app'))).toBe(false);
  });

  test('lets a supported Node through', async () => {
    const io = fakeIo(root);
    expect(await run(['app', '-t', 'demo'], io, { templates, templatesRoot, nodeVersion: '22.12.0' })).toBe(0);
    expect(existsSync(join(root, 'app/README.md'))).toBe(true);
  });

  test('--help and --version still work on an old Node', async () => {
    for (const flag of ['--help', '--version']) {
      const io = fakeIo(root);
      expect(await run([flag], io, { templates, templatesRoot, nodeVersion: '18.0.0' })).toBe(0);
    }
  });
});
