/**
 * Tests for @airo-js/log 0.3.0 consoleSink upgrades:
 *
 *   - 'clean' format (default): payloads deep-cloned as null-prototype
 *     objects — DevTools shows expandable properties with no
 *     `[[Prototype]]: Object` row. Arrays stay arrays; structures that
 *     don't survive JSON (circular) fall back to the raw reference.
 *   - 'raw' format: pass-through references (pre-0.3.0 behaviour).
 *   - Channel tagging: well-known channels print `[@airo-js/<channel>]`;
 *     app-defined channels print bare `[<channel>]` — host domains never
 *     appear under framework branding.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  getConsoleFormat,
  logger,
  resetLogLevels,
  resetSink,
  setConsoleFormat,
  setLogLevel,
} from '@airo-js/log';

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSink(); // route through the real consoleSink
  resetLogLevels();
  setLogLevel('debug');
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  setConsoleFormat('clean');
  resetLogLevels();
});

describe("consoleSink 'clean' format (default)", () => {
  test('is the default', () => {
    expect(getConsoleFormat()).toBe('clean');
  });

  test('payload objects print as null-prototype clones, nested included; arrays stay arrays', () => {
    const data = { pageType: 'quickshop', nested: { a: 1 }, list: [{ b: 2 }] };
    logger('core').info('msg', data);

    const printed = infoSpy.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(printed).not.toBe(data); // snapshot, not the live reference
    expect(Object.getPrototypeOf(printed)).toBeNull();
    expect(Object.getPrototypeOf(printed.nested)).toBeNull();
    expect(Array.isArray(printed.list)).toBe(true);
    expect(Object.getPrototypeOf((printed.list as unknown[])[0])).toBeNull();
    expect(printed).toEqual(JSON.parse(JSON.stringify(data)));
  });

  test('snapshot semantics: mutation after the log call does not alter the printed payload', () => {
    const data: Record<string, unknown> = { count: 1 };
    logger('core').info('msg', data);
    data.count = 999;
    const printed = infoSpy.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(printed.count).toBe(1);
  });

  test('circular payloads fall back to the raw reference instead of throwing', () => {
    const data: Record<string, unknown> = { name: 'loop' };
    data.self = data;
    logger('core').info('msg', data);
    expect(infoSpy.mock.calls[0]?.[2]).toBe(data);
  });
});

describe("consoleSink 'raw' escape hatch", () => {
  test('passes payload references through untouched', () => {
    setConsoleFormat('raw');
    const data = { pageType: 'quickshop' };
    logger('core').info('msg', data);
    expect(infoSpy.mock.calls[0]?.[2]).toBe(data);
  });
});

describe("consoleSink 'json-pretty' format", () => {
  test('renders payloads as indented JSON text inline (not an object)', () => {
    setConsoleFormat('json-pretty');
    const data = { pageType: 'quickshop', nested: { a: 1 } };
    logger('core').info('msg', data);
    const printed = infoSpy.mock.calls[0]?.[2];
    expect(typeof printed).toBe('string');
    expect(printed).toBe(JSON.stringify(data, null, 2));
    // Indented — newlines present, so copy/paste into a diff is readable.
    expect(printed as string).toContain('\n  ');
  });

  test('falls back to the raw reference on circular structures', () => {
    setConsoleFormat('json-pretty');
    const data: Record<string, unknown> = { name: 'loop' };
    data.self = data;
    logger('core').info('msg', data);
    expect(infoSpy.mock.calls[0]?.[2]).toBe(data);
  });
});

describe('channel tagging', () => {
  test('well-known channels tag as [@airo-js/<channel>]', () => {
    logger('core').info('msg');
    expect(infoSpy.mock.calls[0]?.[0]).toBe('[@airo-js/core]');
  });

  test('app-defined channels tag bare — no framework branding', () => {
    logger('analytics').info('msg');
    expect(infoSpy.mock.calls[0]?.[0]).toBe('[analytics]');
  });
});
