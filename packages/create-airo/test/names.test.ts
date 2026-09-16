import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { deriveNames, nameVars, toElementName, toSlug } from '../src/names.js';

describe('toSlug', () => {
  test.each([
    ['my-app', 'my-app'],
    ['My App', 'my-app'],
    ['my_app', 'my-app'],
    ['  --Cool..Thing--  ', 'cool-thing'],
    ['MyApp', 'myapp'],
    ['123', '123'],
    ['___', 'airo-app'],
    ['', 'airo-app'],
  ])('%j → %j', (input, expected) => {
    expect(toSlug(input)).toBe(expected);
  });
});

/**
 * The HTML spec's rule for a custom element name, minus the non-ASCII ranges
 * a slug can never contain. `customElements.define` throws on anything else.
 */
const VALID_ELEMENT = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

describe('toElementName', () => {
  test.each([
    ['my-app', 'my-app'],
    ['airo', 'airo-widget'],
    ['myapp', 'myapp-widget'],
    ['123', 'app-123'],
    ['2-go', 'app-2-go'],
    ['font-face', 'font-face-widget'],
    ['missing-glyph', 'missing-glyph-widget'],
  ])('%j → %j', (slug, expected) => {
    expect(toElementName(slug)).toBe(expected);
  });

  test.each(['airo', 'MyApp', 'my-app', '123', 'my_app', '___', 'annotation-xml', 'x'])(
    'whatever the project name, %j yields a name customElements.define accepts',
    (raw) => {
      expect(toElementName(toSlug(raw))).toMatch(VALID_ELEMENT);
    },
  );
});

describe('deriveNames', () => {
  const cwd = join('/', 'work');

  test('keeps the directory as typed and normalises everything else', () => {
    expect(deriveNames('My App', cwd)).toEqual({
      targetDir: join(cwd, 'My App'),
      packageName: 'my-app',
      displayName: 'My App',
      cartridgeId: 'my-app',
      mailboxName: '__AIRO_MY_APP_PAGES__',
      elementName: 'my-app',
    });
  });

  test('uses the last path segment for the names', () => {
    const names = deriveNames('nested/path/Cool_Thing', cwd);
    expect(names.targetDir).toBe(join(cwd, 'nested', 'path', 'Cool_Thing'));
    expect(names.packageName).toBe('cool-thing');
  });

  test('"." scaffolds into the current directory and names the project after it', () => {
    const names = deriveNames('.', join('/', 'projects', 'shop-front'));
    expect(names.targetDir).toBe(join('/', 'projects', 'shop-front'));
    expect(names.packageName).toBe('shop-front');
  });

  test('the mailbox name follows __AIRO_<ID_UPPER>_PAGES__', () => {
    expect(deriveNames('docs-site', cwd).mailboxName).toBe('__AIRO_DOCS_SITE_PAGES__');
  });

  test('nameVars exposes every derived name as a placeholder', () => {
    expect(nameVars(deriveNames('my-app', cwd))).toEqual({
      PKG_NAME: 'my-app',
      DISPLAY_NAME: 'My App',
      CARTRIDGE_ID: 'my-app',
      MAILBOX_NAME: '__AIRO_MY_APP_PAGES__',
      ELEMENT_NAME: 'my-app',
    });
  });
});
