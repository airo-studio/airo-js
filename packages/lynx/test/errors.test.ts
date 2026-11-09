/**
 * A bare "not a function" from a built-in the engine lacks: the report
 * names what is missing, and the built-in stays absent so feature checks
 * still find out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noopSink, resetSink, setSink } from '@airo-js/log';

import { missingBuiltIns, report } from '../src/runtime/errors.js';

const own = Object.getOwnPropertyDescriptor(String.prototype, 'normalize')!;
beforeEach(() => setSink(noopSink));
afterEach(() => {
  Object.defineProperty(String.prototype, 'normalize', own);
  resetSink();
});

describe('a TypeError from a missing built-in', () => {
  it('names the built-ins the engine lacks, in what onError and the log receive', () => {
    delete (String.prototype as { normalize?: unknown }).normalize;
    expect(missingBuiltIns()).toEqual(['String.prototype.normalize']);
    expect(typeof ''.normalize).toBe('undefined');
    const onError = vi.fn();
    report(onError, 'hydrate', new TypeError('not a function'));
    expect(onError.mock.calls[0]![0].error.message).toBe(
      'not a function [@airo-js/lynx: this engine has no String.prototype.normalize; a call to it fails this way]',
    );
  });

  it('adds nothing where the engine has them, or to other errors', () => {
    expect(missingBuiltIns()).toEqual([]);
    const onError = vi.fn();
    report(onError, 'hydrate', new TypeError('not a function'));
    delete (String.prototype as { normalize?: unknown }).normalize;
    report(onError, 'hydrate', new RangeError('not a function'));
    expect(onError.mock.calls.map(([i]) => i.error.message)).toEqual(['not a function', 'not a function']);
  });
});
