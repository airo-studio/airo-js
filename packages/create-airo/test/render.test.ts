import { describe, expect, test } from 'vitest';

import { isRendered, render, TemplateError } from '../src/render.js';

describe('render', () => {
  test('substitutes every placeholder, including repeats', () => {
    expect(render('__A__ and __B_2__, again __A__', { A: 'x', B_2: 'y' })).toBe('x and y, again x');
  });

  test('an unknown placeholder throws, naming the token and the file', () => {
    // A typo'd placeholder must never ship verbatim into someone's project.
    expect(() => render('name: __PKG_NAM__', { PKG_NAME: 'app' }, 'package.json')).toThrow(TemplateError);
    expect(() => render('name: __PKG_NAM__', { PKG_NAME: 'app' }, 'package.json')).toThrow(
      /__PKG_NAM__ in package\.json/,
    );
  });

  test('one pass: a value shaped like a placeholder is not substituted again', () => {
    // Mailbox names look exactly like placeholders.
    expect(render("mailboxName: '__MAILBOX_NAME__'", { MAILBOX_NAME: '__AIRO_MY_APP_PAGES__' })).toBe(
      "mailboxName: '__AIRO_MY_APP_PAGES__'",
    );
  });

  test('lowercase dunders are ordinary code, not placeholders', () => {
    const code = 'const d = __dirname; obj.__proto__; __defineGetter__';
    expect(render(code, {})).toBe(code);
  });

  test('text with no placeholders is returned unchanged', () => {
    expect(render('plain', {})).toBe('plain');
  });
});

describe('isRendered', () => {
  test.each(['index.ts', 'server.mjs', 'package.json', 'README.md', 'index.html', 'site.css', '_gitignore'])(
    '%s is rendered',
    (name) => {
      expect(isRendered(name)).toBe(true);
    },
  );

  test.each(['logo.png', 'font.woff2', 'data.bin', 'LICENSE', '.gitignore'])('%s is copied as-is', (name) => {
    expect(isRendered(name)).toBe(false);
  });
});
