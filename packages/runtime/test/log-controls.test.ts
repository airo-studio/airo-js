/**
 * Tests for the @airo-js/log 0.3.0 control surface:
 *
 *   - Default threshold is 'error' — only genuine failures flow unprompted.
 *   - `applyLogDirective` grammar: global levels, aliases (all/v/verbose →
 *     debug, off → silent), `channel:level` pairs (any channel string),
 *     comma combos, unknown-token skip.
 *   - `initLogControls`: `?airo-log=` param wins and persists to the
 *     sanitizer-compliant `__airo_log` key (overwrite-only — `off` is a
 *     stored directive, never a removeItem); persisted key applies on the
 *     next load; manual `airo-log` console convention is the read-only
 *     fallback; once-guard keeps a second mount from clobbering
 *     programmatic `setLogLevel` calls.
 *
 * Lives in runtime/test (not packages/log) per precedent — the log
 * package has no test rig; runtime's happy-dom + jsdom parity runs
 * provide `location`/`localStorage` for the browser paths.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { AiroEvent } from '@airo-js/log';
import {
  applyLogDirective,
  getChannelLevel,
  getLogLevel,
  initLogControls,
  logger,
  resetLogControls,
  resetLogLevels,
  resetSink,
  setLogLevel,
  setSink,
} from '@airo-js/log';

beforeEach(() => {
  resetLogControls();
  resetLogLevels();
  localStorage.clear();
  history.replaceState(null, '', location.pathname);
});

afterEach(() => {
  resetSink();
  resetLogLevels();
  resetLogControls();
  localStorage.clear();
  history.replaceState(null, '', location.pathname);
});

describe('default threshold', () => {
  test("is 'error' — info/warn/debug drop, error flows", () => {
    const captured: AiroEvent[] = [];
    setSink({ emit: (e) => captured.push(e) });
    const log = logger('app');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(captured.map((e) => e.level)).toEqual(['error']);
    expect(getLogLevel()).toBe('error');
  });
});

describe('applyLogDirective grammar', () => {
  test('global level names apply globally', () => {
    expect(applyLogDirective('warn')).toBe(true);
    expect(getLogLevel()).toBe('warn');
  });

  test('aliases: all/v/verbose → debug, off → silent', () => {
    applyLogDirective('all');
    expect(getLogLevel()).toBe('debug');
    applyLogDirective('off');
    expect(getLogLevel()).toBe('silent');
    applyLogDirective('v');
    expect(getLogLevel()).toBe('debug');
    applyLogDirective('verbose');
    expect(getLogLevel()).toBe('debug');
  });

  test('channel:level applies per-channel — app-defined channels included', () => {
    expect(applyLogDirective('analytics:debug')).toBe(true);
    expect(getChannelLevel('analytics')).toBe('debug');
    expect(getLogLevel()).toBe('error'); // global untouched
  });

  test('channel verbose alias: analytics:v', () => {
    applyLogDirective('analytics:v');
    expect(getChannelLevel('analytics')).toBe('debug');
  });

  test('comma combos: warn,app:debug', () => {
    applyLogDirective('warn,app:debug');
    expect(getLogLevel()).toBe('warn');
    expect(getChannelLevel('app')).toBe('debug');
  });

  test('bare non-level token is a channel → debug (the common reflex)', () => {
    expect(applyLogDirective('analytics')).toBe(true);
    expect(getChannelLevel('analytics')).toBe('debug');
    expect(getLogLevel()).toBe('error'); // global untouched
  });

  test('bare level alias still applies globally, not as a channel', () => {
    applyLogDirective('warn');
    expect(getLogLevel()).toBe('warn');
    expect(getChannelLevel('warn')).toBeNull(); // no junk channel named "warn"
  });

  test('level-alias head in channel position → global intent, suffix ignored', () => {
    // `all:v` / `debug:v` are natural to type once `:v` exists; they must
    // NOT materialize a channel named "all" and drop the global intent.
    applyLogDirective('all:v');
    expect(getLogLevel()).toBe('debug');
    expect(getChannelLevel('all')).toBeNull();

    resetLogLevels();
    applyLogDirective('debug:v');
    expect(getLogLevel()).toBe('debug');
    expect(getChannelLevel('debug')).toBeNull();
  });

  test('empty directive returns false; a bare typo is a harmless junk channel', () => {
    expect(applyLogDirective('')).toBe(false);
    // `nope` is not a level → treated as a channel:debug. Harmless: nothing
    // logs to a channel named "nope". Applies (true), never throws.
    expect(applyLogDirective('nope')).toBe(true);
    expect(getChannelLevel('nope')).toBe('debug');
  });

  test('combos: junk head applies as channel, real global still lands', () => {
    applyLogDirective('nonsense,info');
    expect(getLogLevel()).toBe('info');
    expect(getChannelLevel('nonsense')).toBe('debug');
  });

  test('case-insensitive with whitespace tolerance', () => {
    applyLogDirective(' Analytics:DEBUG , WARN ');
    expect(getChannelLevel('analytics')).toBe('debug');
    expect(getLogLevel()).toBe('warn');
  });
});

describe('initLogControls', () => {
  test('?airo-log= param applies and persists to __airo_log', () => {
    history.replaceState(null, '', '?airo-log=analytics:v');
    initLogControls();
    expect(getChannelLevel('analytics')).toBe('debug');
    expect(localStorage.getItem('__airo_log')).toBe('analytics:v');
  });

  test('persisted __airo_log applies on a later load with no param', () => {
    localStorage.setItem('__airo_log', 'debug');
    initLogControls();
    expect(getLogLevel()).toBe('debug');
  });

  test('?airo-log=off is persisted (overwrite, not removeItem) and silences', () => {
    localStorage.setItem('__airo_log', 'debug'); // earlier session's opt-in
    history.replaceState(null, '', '?airo-log=off');
    initLogControls();
    expect(getLogLevel()).toBe('silent');
    // The off-switch is a stored directive — key overwritten, never removed.
    expect(localStorage.getItem('__airo_log')).toBe('off');
  });

  test('manual airo-log console convention is the fallback when nothing auto-persisted', () => {
    localStorage.setItem('airo-log', 'info');
    initLogControls();
    expect(getLogLevel()).toBe('info');
    // Read-only fallback: the framework never writes the manual key.
    expect(localStorage.getItem('__airo_log')).toBeNull();
  });

  test('auto-persisted __airo_log beats the manual airo-log key', () => {
    localStorage.setItem('airo-log', 'info');
    localStorage.setItem('__airo_log', 'off');
    initLogControls();
    expect(getLogLevel()).toBe('silent');
  });

  test('once-guard: a second call (second mount) does not clobber programmatic levels', () => {
    localStorage.setItem('__airo_log', 'debug');
    initLogControls();
    expect(getLogLevel()).toBe('debug');
    setLogLevel('silent'); // host decides programmatically post-init
    initLogControls(); // e.g. a second mountCartridge on the same page
    expect(getLogLevel()).toBe('silent');
  });

  test('no param, no storage: levels untouched', () => {
    initLogControls();
    expect(getLogLevel()).toBe('error');
  });
});

describe('sanitizer-compat: setItem key is a literal (consumer rsp_mryxzvt0 blocker)', () => {
  // Sanitized-bundle consumers statically prove every localStorage.setItem
  // targets a literal `__airo_*` key. A const (LOG_STORAGE_KEY) survives
  // minification as a variable and fails that proof — so the WRITE site must
  // use the literal `'__airo_log'`. A unit test can't observe minifier
  // inlining; this guards the source against a refactor that reverts to the
  // const. Runtime behaviour (persistence under __airo_log) is covered above.
  test("localStorage.setItem uses the literal '__airo_log', not a variable", () => {
    // cwd is the runtime package root under vitest; log is a sibling package.
    const src = readFileSync(resolve(process.cwd(), '../log/src/index.ts'), 'utf8');
    expect(src).toContain("localStorage.setItem('__airo_log',");
    expect(src).not.toMatch(/localStorage\.setItem\(LOG_STORAGE_KEY/);
  });
});
