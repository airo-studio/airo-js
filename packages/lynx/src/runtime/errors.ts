/**
 * How the runtime fails: by name, in the log, and through the host's
 * `onError`, never by doing nothing.
 *
 * A refusal is the facade's answer to a DOM member or browser API it does
 * not implement on device (layout reads, dialogs, `location`, storage, …).
 * It is thrown, so the calling handler stops where a browser would have
 * carried on, and it is reported before it is thrown, so a refusal inside
 * an async handler, which nothing upstream catches, still reaches the log
 * and the host.
 */

import { logger } from '@airo-js/log';

export const log = logger('lynx');

/** Where in the mount an error surfaced. */
export type LynxErrorPhase = 'render' | 'hydrate' | 'event' | 'navigate';

/** A DOM member or browser API the device facade does not implement. */
export class LynxRefusalError extends Error {
  constructor(
    /** What was refused, as code would name it: `Element.getBoundingClientRect`, `window.location`. */
    readonly member: string,
    detail?: string,
  ) {
    super(
      `[@airo-js/lynx] ${member} is not available on device${detail ? `: ${detail}` : ''}. Rewrite that part of the handler for native, or leave it to the host.`,
    );
    this.name = 'LynxRefusalError';
  }
}

/** An HTML element the tree pass has no Lynx mapping for. */
export class UnmappedElementError extends LynxRefusalError {
  constructor(readonly tag: string) {
    super(`<${tag}>`, 'the tree pass has no Lynx element for it yet');
    this.name = 'UnmappedElementError';
  }
}

export interface LynxErrorInfo {
  phase: LynxErrorPhase;
  error: Error;
  /** Set for refusals: the member that was refused. */
  member?: string;
}

export type ErrorReporter = (info: LynxErrorInfo) => void;

const reported = new WeakSet<object>();

/**
 * Built-in methods the main thread's engine may lack. They stay absent, so
 * a `typeof '…'.normalize === 'function'` check still finds out; a call
 * made without one fails as a bare "not a function", with no name and a
 * minified stack. `normalize` is Unicode data, as `Intl` is.
 */
const BUILT_IN_METHODS: readonly [string, () => unknown][] = [['String.prototype.normalize', () => String.prototype.normalize]];

/** The built-in methods this engine lacks, for a TypeError that names nothing. */
export function missingBuiltIns(): string[] {
  return BUILT_IN_METHODS.filter(([, read]) => typeof read() !== 'function').map(([name]) => name);
}

/**
 * A TypeError such as "not a function" with no name in it may be a call to
 * a built-in the engine lacks: say which ones it lacks, in the message the
 * log and `onError` carry.
 */
function nameMissingBuiltIns(error: Error): void {
  if (!(error instanceof TypeError) || !/not a function|not a constructor|undefined is not/i.test(error.message)) return;
  const missing = missingBuiltIns();
  if (missing.length === 0) return;
  try {
    error.message += ` [@airo-js/lynx: this engine has no ${missing.join(', ')}; a call to it fails this way]`;
  } catch {
    // A frozen error keeps its message; the log still has the stack.
  }
}

/** Log and forward an error once, however many layers it passes through. */
export function report(reporter: ErrorReporter | undefined, phase: LynxErrorPhase, err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (reported.has(error)) return error;
  reported.add(error);
  nameMissingBuiltIns(error);
  const member = error instanceof LynxRefusalError ? error.member : undefined;
  log.error(error.message, error, { phase, ...(member ? { member } : {}) });
  try {
    reporter?.({ phase, error, ...(member ? { member } : {}) });
  } catch (hostErr) {
    log.error('[@airo-js/lynx] the host onError handler threw', hostErr, { phase });
  }
  return error;
}

/** Report a refusal and throw it. */
export function refuse(reporter: ErrorReporter | undefined, phase: LynxErrorPhase, member: string, detail?: string): never {
  throw report(reporter, phase, new LynxRefusalError(member, detail));
}
