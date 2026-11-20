import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { VERSION } from '../src/index.js';
import { run } from '../src/run.js';
import type { TemplateInfo } from '../src/templates.js';
import { AIRO_VERSIONS } from '../src/versions.js';
import { fakeIo, tempDir, writeTree } from './helpers.js';

/**
 * Fixture templates are written to a temp directory per test rather than
 * committed, so no placeholder-bearing fixture ever sits where biome, knip or
 * tsc would read it.
 */
const BINARY = new Uint8Array([0, 1, 2, ...Buffer.from('__NOT_A_TOKEN__'), 255]);

const DEMO: TemplateInfo = { name: 'demo', description: 'A demo starter', nextScripts: ['dev'] };
const OTHER: TemplateInfo = { name: 'site', description: 'The default starter', nextScripts: ['build', 'start'] };

let root: string;
let cleanup: () => void;
let templatesRoot: string;
let cwd: string;

beforeEach(() => {
  ({ dir: root, cleanup } = tempDir());
  templatesRoot = join(root, 'templates');
  cwd = join(root, 'work');
  mkdirSync(cwd);
  writeTree(join(templatesRoot, 'demo'), {
    'package.json': JSON.stringify({
      name: '__PKG_NAME__',
      dependencies: { '@airo-js/core': '__V_CORE__', '@airo-js/log': '__V_LOG__' },
      airo: { scaffoldedWith: 'create-airo@__CREATE_AIRO_VERSION__', template: '__TEMPLATE__' },
    }),
    'README.md': '# __DISPLAY_NAME__\n\nmailbox: __MAILBOX_NAME__, line __TARGET_LINE__\n',
    _gitignore: 'node_modules\ndist\n',
    'src/cartridge.ts': "export const id = '__CARTRIDGE_ID__';\n",
    'assets/logo.bin': BINARY,
  });
  writeTree(join(templatesRoot, 'site'), { 'README.md': '# __DISPLAY_NAME__\n' });
});

afterEach(() => cleanup());

const both = [DEMO, OTHER] as const;

describe('help and version', () => {
  test('--help prints usage with the templates and exits 0', async () => {
    const io = fakeIo(cwd);
    expect(await run(['--help'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.out).toMatch(/Usage:/);
    expect(io.out).toMatch(/demo\s+A demo starter/);
  });

  test('--version prints the version and nothing else', async () => {
    const io = fakeIo(cwd);
    expect(await run(['--version'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.out).toBe(`${VERSION}\n`);
  });
});

describe('usage errors exit 2', () => {
  test('an unknown flag', async () => {
    const io = fakeIo(cwd);
    expect(await run(['--nope'], io, { templates: both, templatesRoot })).toBe(2);
    expect(io.err).toMatch(/--nope/);
    expect(io.err).toMatch(/Usage:/);
  });

  test('an unknown template, listing the real ones', async () => {
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'widgit'], io, { templates: both, templatesRoot })).toBe(2);
    expect(io.err).toMatch(/Unknown template "widgit"\. Available: demo, site\./);
    expect(existsSync(join(cwd, 'app'))).toBe(false);
  });

  test('no name, no terminal, no --yes: the error says how to fix it', async () => {
    const io = fakeIo(cwd);
    expect(await run(['-t', 'demo'], io, { templates: both, templatesRoot })).toBe(2);
    expect(io.err).toMatch(/No project name given, and no terminal to ask/);
  });

  test('no template, no terminal, no --yes', async () => {
    const io = fakeIo(cwd);
    expect(await run(['app'], io, { templates: both, templatesRoot })).toBe(2);
    expect(io.err).toMatch(/Pass --template <name>, or --yes/);
  });
});

describe('scaffolding', () => {
  test('writes the template with every placeholder substituted', async () => {
    const io = fakeIo(cwd);
    expect(await run(['My App', '-t', 'demo'], io, { templates: both, templatesRoot })).toBe(0);

    const dir = join(cwd, 'My App');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg).toEqual({
      name: 'my-app',
      dependencies: {
        '@airo-js/core': `^${AIRO_VERSIONS['@airo-js/core']}`,
        '@airo-js/log': `^${AIRO_VERSIONS['@airo-js/log']}`,
      },
      airo: { scaffoldedWith: `create-airo@${VERSION}`, template: 'demo' },
    });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe(
      '# My App\n\nmailbox: __AIRO_MY_APP_PAGES__, line 0.11\n',
    );
    expect(readFileSync(join(dir, 'src/cartridge.ts'), 'utf8')).toBe("export const id = 'my-app';\n");
  });

  test('--exact pins @airo-js versions instead of writing ^ ranges', async () => {
    expect(await run(['app', '-t', 'demo', '--exact'], fakeIo(cwd), { templates: both, templatesRoot })).toBe(0);
    const pkg = JSON.parse(readFileSync(join(cwd, 'app/package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({
      '@airo-js/core': AIRO_VERSIONS['@airo-js/core'],
      '@airo-js/log': AIRO_VERSIONS['@airo-js/log'],
    });
  });

  test('a CamelCase directory keeps its casing as the display name', async () => {
    await run(['GreenGrocer', '-t', 'demo'], fakeIo(cwd), { templates: both, templatesRoot });
    expect(readFileSync(join(cwd, 'GreenGrocer/README.md'), 'utf8')).toMatch(/^# GreenGrocer\n/);
    expect(JSON.parse(readFileSync(join(cwd, 'GreenGrocer/package.json'), 'utf8')).name).toBe('greengrocer');
  });

  test('_gitignore is written as .gitignore', async () => {
    await run(['app', '-t', 'demo'], fakeIo(cwd), { templates: both, templatesRoot });
    expect(readFileSync(join(cwd, 'app/.gitignore'), 'utf8')).toBe('node_modules\ndist\n');
    expect(existsSync(join(cwd, 'app/_gitignore'))).toBe(false);
  });

  test('non-text files are copied byte-for-byte, placeholder-shaped bytes included', async () => {
    await run(['app', '-t', 'demo'], fakeIo(cwd), { templates: both, templatesRoot });
    expect(new Uint8Array(readFileSync(join(cwd, 'app/assets/logo.bin')))).toEqual(BINARY);
  });

  test('lists every file before writing, and prints next steps for the template', async () => {
    const io = fakeIo(cwd);
    await run(['app', '-t', 'demo'], io, { templates: both, templatesRoot });
    for (const path of ['.gitignore', 'README.md', 'assets/logo.bin', 'package.json', 'src/cartridge.ts']) {
      expect(io.out).toContain(`  ${path}\n`);
    }
    expect(io.out).toMatch(/Next:\n {2}cd app\n {2}npm install\n {2}npm run dev\n$/);
  });

  test('next steps use the package manager that ran the command', async () => {
    const io = fakeIo(cwd, { userAgent: 'pnpm/9.4.0 npm/? node/v24.3.0 darwin arm64' });
    await run(['app', '-t', 'site'], io, { templates: both, templatesRoot });
    expect(io.out).toMatch(/pnpm install\n {2}pnpm build\n {2}pnpm start\n$/);
  });

  test('a directory name with a space is quoted in the cd step', async () => {
    const io = fakeIo(cwd);
    await run(['My App', '-t', 'demo'], io, { templates: both, templatesRoot });
    expect(io.out).toContain('cd "My App"');
  });

  test('--yes with no name scaffolds airo-app from the default template', async () => {
    const io = fakeIo(cwd);
    expect(await run(['--yes'], io, { templates: both, templatesRoot })).toBe(0);
    expect(existsSync(join(cwd, 'airo-app/README.md'))).toBe(true);
    expect(existsSync(join(cwd, 'airo-app/package.json'))).toBe(false); // `site`, not `demo`
  });

  test('a single shipped template is used without asking', async () => {
    const io = fakeIo(cwd, { interactive: true });
    expect(await run(['app'], io, { templates: [DEMO], templatesRoot })).toBe(0);
    expect(io.questions).toEqual([]);
    expect(io.out).toMatch(/Template: demo \(the only one in this build\)/);
  });

  test('a build with no templates exits 1 with a plain message', async () => {
    const io = fakeIo(cwd);
    expect(await run(['app', '--yes'], io, { templates: [], templatesRoot })).toBe(1);
    expect(io.err).toMatch(/ships no templates/);
  });

  test('the banner marks a prerelease as beta and names the target line', async () => {
    const io = fakeIo(cwd);
    await run(['app', '-t', 'demo'], io, { templates: both, templatesRoot });
    expect(io.out).toMatch(/^create-airo 1\.0\.0-beta\.\d+ \(beta\)\nScaffolds against @airo-js 0\.11\./);
  });
});

describe('the target directory', () => {
  test('a non-empty directory is refused with exit 1, and left untouched', async () => {
    writeTree(join(cwd, 'app'), { 'mine.txt': 'keep' });
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'demo'], io, { templates: both, templatesRoot })).toBe(1);
    expect(io.err).toMatch(/app is not empty.*--force/);
    expect(existsSync(join(cwd, 'app/package.json'))).toBe(false);
    expect(readFileSync(join(cwd, 'app/mine.txt'), 'utf8')).toBe('keep');
  });

  test('--force writes into a non-empty directory and keeps unrelated files', async () => {
    writeTree(join(cwd, 'app'), { 'mine.txt': 'keep' });
    expect(await run(['app', '-t', 'demo', '--force'], fakeIo(cwd), { templates: both, templatesRoot })).toBe(0);
    expect(existsSync(join(cwd, 'app/package.json'))).toBe(true);
    expect(readFileSync(join(cwd, 'app/mine.txt'), 'utf8')).toBe('keep');
  });

  test('the file list marks every file that already exists, and the refusal counts them', async () => {
    writeTree(join(cwd, 'app'), { 'README.md': 'mine', 'mine.txt': 'keep' });
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'demo'], io, { templates: both, templatesRoot })).toBe(1);
    expect(io.out).toContain('  README.md  (overwrites)\n');
    expect(io.out).toContain('  package.json\n');
    expect(io.err).toMatch(/app is not empty, and 1 file above would be replaced/);
    expect(readFileSync(join(cwd, 'app/README.md'), 'utf8')).toBe('mine');
  });

  test('--force says how many existing files it replaces, then replaces them', async () => {
    writeTree(join(cwd, 'app'), { 'README.md': 'mine', 'package.json': '{}' });
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'demo', '--force'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.out).toContain('  package.json  (overwrites)\n');
    expect(io.out).toMatch(/2 existing files will be replaced\./);
    expect(readFileSync(join(cwd, 'app/README.md'), 'utf8')).not.toBe('mine');
  });

  test('--dry-run previews a non-empty directory instead of refusing it, and writes nothing', async () => {
    writeTree(join(cwd, 'app'), { 'README.md': 'mine' });
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'demo', '--dry-run'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.out).toContain('  README.md  (overwrites)\n');
    expect(io.out).toMatch(/1 existing file will be replaced \(a real run also needs --force\)/);
    expect(io.out).toMatch(/Dry run — nothing was written/);
    expect(readFileSync(join(cwd, 'app/README.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(cwd, 'app/package.json'))).toBe(false);
  });

  test('a directory holding only .git counts as empty', async () => {
    mkdirSync(join(cwd, 'app/.git'), { recursive: true });
    expect(await run(['app', '-t', 'demo'], fakeIo(cwd), { templates: both, templatesRoot })).toBe(0);
  });

  test('a file where the directory should go is refused', async () => {
    writeFileSync(join(cwd, 'app'), 'in the way');
    expect(await run(['app', '-t', 'demo'], fakeIo(cwd), { templates: both, templatesRoot })).toBe(1);
  });

  test('--dry-run lists the files and writes nothing', async () => {
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'demo', '--dry-run'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.out).toContain('  package.json\n');
    expect(io.out).toMatch(/Dry run — nothing was written/);
    expect(existsSync(join(cwd, 'app'))).toBe(false);
  });

  test('an unknown placeholder fails before anything is written', async () => {
    writeTree(join(templatesRoot, 'demo'), { 'src/broken.ts': 'export const x = __TYPO__;\n' });
    const io = fakeIo(cwd);
    expect(await run(['app', '-t', 'demo'], io, { templates: both, templatesRoot })).toBe(1);
    expect(io.err).toMatch(/Unknown template placeholder __TYPO__ in src\/broken\.ts/);
    expect(existsSync(join(cwd, 'app'))).toBe(false);
  });
});

describe('prompts', () => {
  test('asks for the name and the template when a human is present', async () => {
    const io = fakeIo(cwd, { interactive: true, answers: ['shop', '1'] });
    expect(await run([], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.questions).toHaveLength(2);
    expect(existsSync(join(cwd, 'shop/package.json'))).toBe(true);
  });

  test('empty answers take the defaults: airo-app, and the default template', async () => {
    const io = fakeIo(cwd, { interactive: true, answers: ['', ''] });
    expect(await run([], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.questions[0]).toBe('Project name [airo-app]: ');
    expect(io.questions[1]).toMatch(/Number \[2\]/); // `site` is the default, listed second
    expect(existsSync(join(cwd, 'airo-app/README.md'))).toBe(true);
  });

  test('an out-of-range choice asks again', async () => {
    const io = fakeIo(cwd, { interactive: true, answers: ['shop', '9', 'x', '1'] });
    expect(await run([], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.err.match(/Pick a number between 1 and 2/g)).toHaveLength(2);
  });

  test('--yes never prompts, even with a terminal', async () => {
    const io = fakeIo(cwd, { interactive: true });
    expect(await run(['--yes'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.questions).toEqual([]);
  });

  test('a flag that answers a question skips that question', async () => {
    const io = fakeIo(cwd, { interactive: true, answers: ['shop'] });
    expect(await run(['-t', 'demo'], io, { templates: both, templatesRoot })).toBe(0);
    expect(io.questions).toEqual(['Project name [airo-app]: ']);
  });
});
