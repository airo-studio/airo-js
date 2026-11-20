import { describe, expect, test } from 'vitest';

import { parseCliArgs, UsageError, usage } from '../src/args.js';

describe('parseCliArgs', () => {
  test('no arguments means every flag off and nothing named', () => {
    expect(parseCliArgs([])).toEqual({
      name: undefined,
      template: undefined,
      yes: false,
      dryRun: false,
      force: false,
      exact: false,
      help: false,
      version: false,
    });
  });

  test('reads a name and every long flag', () => {
    expect(parseCliArgs(['my-app', '--template', 'site', '--yes', '--dry-run', '--force', '--exact'])).toMatchObject({
      name: 'my-app',
      template: 'site',
      yes: true,
      dryRun: true,
      force: true,
      exact: true,
    });
  });

  test('reads short flags', () => {
    expect(parseCliArgs(['-t', 'site', '-y'])).toMatchObject({ template: 'site', yes: true });
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
  });

  test('--template=value works too', () => {
    expect(parseCliArgs(['--template=site']).template).toBe('site');
  });

  test('a blank name is no name', () => {
    expect(parseCliArgs(['  ']).name).toBeUndefined();
  });

  test('an unknown flag is a usage error', () => {
    expect(() => parseCliArgs(['--templat', 'site'])).toThrow(UsageError);
  });

  test('a flag missing its value is a usage error', () => {
    expect(() => parseCliArgs(['--template'])).toThrow(UsageError);
  });

  test('two names is a usage error that says what it got', () => {
    expect(() => parseCliArgs(['one', 'two'])).toThrow(/got 2: one two/);
  });
});

describe('usage', () => {
  test('lists templates with their descriptions', () => {
    const text = usage([{ name: 'site', description: 'A website', nextScripts: [] }]);
    expect(text).toMatch(/site\s+A website/);
  });

  test('says plainly when a build ships no templates', () => {
    expect(usage([])).toContain('(none in this build)');
  });

  test('tells npm users about the `--` separator', () => {
    expect(usage([])).toMatch(/npm create airo@beta \[project-name\] -- \[options\]/);
  });
});
