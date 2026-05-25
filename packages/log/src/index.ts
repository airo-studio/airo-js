/**
 * @airo-js/log — sink-based structured event logging.
 *
 * Replaces scattered `console.*` calls across `@airo-js/*` packages with a
 * single dispatcher. Default sink is the browser/node console (verbatim
 * behaviour preservation); apps replace the sink via `setSink(...)` to
 * feed events into devtools panels, Sentry / Datadog breadcrumbs, or any
 * other observability target.
 *
 * Design intent:
 *   - Zero overhead in production unless replaced — the default `consoleSink`
 *     just calls `console.warn` / `console.error` with the formatted tag.
 *   - Structured events (`AiroEvent`) so consumers can filter, correlate,
 *     and serialize without parsing strings.
 *   - Singleton sink per process — the framework + apps share one. Replacing
 *     mid-flight is fine; events emit through whichever sink is current.
 *
 * What this is NOT:
 *   - Not a replacement for thrown errors. Throws still propagate to the
 *     caller via promise rejection / try-catch. The sink is for *side-channel*
 *     observability (warnings, recoverable errors, lifecycle phases).
 *   - Not a metrics or telemetry pipeline. Sinks can forward to one, but
 *     this package doesn't ship the forwarding logic.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Source channel — typically the emitting package's short name. Apps that
 * embed framework events into their own logging can use the channel to
 * route events to different destinations.
 */
export type LogChannel =
  | 'core'
  | 'runtime'
  | 'embed'
  | 'ssr'
  | 'cartridge-kit'
  | 'mcp'
  /** Apps emit on this channel for their own structured events. */
  | 'app';

export interface AiroEvent {
  /** epoch milliseconds */
  ts: number;
  channel: LogChannel;
  level: LogLevel;
  /** Human-readable message; safe to display verbatim. */
  msg: string;
  /**
   * Optional sub-channel / phase identifier — e.g. mountCartridge phase
   * (`'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount'`), pipeline step,
   * gate id, page id. Free-form so callers don't have to negotiate types.
   */
  phase?: string;
  /** Optional widget id from the host app. */
  widgetId?: string;
  /** Optional cartridge id. */
  cartridgeId?: string;
  /** Optional structured payload. */
  data?: Record<string, unknown>;
  /**
   * Error info (typically present when level === 'error'). Captured as a
   * plain object so the event is JSON-serializable for sinks that forward
   * to a server.
   */
  err?: ErrorInfo;
}

export interface ErrorInfo {
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface AiroSink {
  emit(event: AiroEvent): void;
}

/**
 * Default sink — formats the event tag and dispatches to the matching
 * `console.*` method. Behaviour is intentionally close to the existing
 * `console.warn('[@airo-js/embed] ...')` calls this package replaces, so
 * apps that don't opt into the sink see no behavioural change.
 */
export const consoleSink: AiroSink = {
  emit(event) {
    const tag = `[@airo-js/${event.channel}]${event.phase ? ` ${event.phase}` : ''}`;
    const args: unknown[] = [tag, event.msg];
    if (event.data) args.push(event.data);
    if (event.err) args.push(event.err);
    switch (event.level) {
      case 'debug':
        console.debug(...args);
        return;
      case 'info':
        console.info(...args);
        return;
      case 'warn':
        console.warn(...args);
        return;
      case 'error':
        console.error(...args);
        return;
    }
  },
};

/** No-op sink — useful for tests that don't want event noise. */
export const noopSink: AiroSink = {
  emit() {
    // intentionally empty
  },
};

let currentSink: AiroSink = consoleSink;

/**
 * Replace the active sink. Subsequent `logger(...)` emissions dispatch to
 * the new sink. Apps typically call this once at boot:
 *
 *   import { setSink } from '@airo-js/log';
 *   setSink({ emit: (e) => Sentry.addBreadcrumb({ ... }) });
 *
 * Devtools panels call this to subscribe; multiplexing sinks (forward to
 * console + capture to ring buffer) is a sink-implementation concern.
 */
export function setSink(sink: AiroSink): void {
  currentSink = sink;
}

/** Return the active sink. */
export function getSink(): AiroSink {
  return currentSink;
}

/**
 * Reset the sink to `consoleSink`. Useful after tests or when an app wants
 * to disable a previously-installed observability sink.
 */
export function resetSink(): void {
  currentSink = consoleSink;
}

// ─── Level filtering ────────────────────────────────────────────────
// Threshold filter that runs BEFORE the sink. Events whose level falls
// below the active threshold are dropped — they never reach the sink.
// Composes with `setSink`: a custom sink keeps working, just sees fewer
// events. Two knobs: a global threshold (`setLogLevel`) and per-channel
// overrides (`setChannelLevel`). The per-channel value wins for that
// channel only; channels without an override inherit the global level.
//
// Default threshold is `'debug'` — every event flows through. This makes
// the threshold API a non-breaking addition: apps that don't call
// `setLogLevel` see the pre-0.2.0 behaviour. Apps tighten to `'warn'`
// for prod, `'silent'` for SSR / Lambda contexts where structured
// upstream logs already capture what they need.
//
// 'silent' is the sentinel above 'error'; nothing emits through a
// channel pinned at 'silent', regardless of event level.

type LevelOrSilent = LogLevel | 'silent';

const LEVEL_RANK: Record<LevelOrSilent, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

let currentLevel: LevelOrSilent = 'debug';
const channelLevels: Map<LogChannel, LevelOrSilent> = new Map();

function effectiveLevelFor(channel: LogChannel): LevelOrSilent {
  return channelLevels.get(channel) ?? currentLevel;
}

function shouldEmit(channel: LogChannel, level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[effectiveLevelFor(channel)];
}

/**
 * Set the global log-level threshold. Events whose level is below
 * `level` are dropped. Default `'debug'` (everything flows). Channels
 * with an explicit `setChannelLevel` override win over the global.
 *
 *   setLogLevel('warn')    // prod: drop debug + info events
 *   setLogLevel('silent')  // SSR: drop everything
 *   setLogLevel('debug')   // dev: pre-0.2.0 default
 */
export function setLogLevel(level: LevelOrSilent): void {
  currentLevel = level;
}

/** Current global threshold. */
export function getLogLevel(): LevelOrSilent {
  return currentLevel;
}

/**
 * Set a per-channel level threshold. Overrides the global level for
 * that channel only. Useful for "silence noisy `core` chatter in this
 * stage but keep `app` channel at info" patterns.
 *
 *   setChannelLevel('core', 'warn')    // quiet the framework
 *   setChannelLevel('app', 'silent')   // and the app's own logger
 */
export function setChannelLevel(channel: LogChannel, level: LevelOrSilent): void {
  channelLevels.set(channel, level);
}

/**
 * Current threshold for a channel. Returns `null` when no override is
 * set (channel inherits the global level). Use `getLogLevel()` for the
 * effective fallback.
 */
export function getChannelLevel(channel: LogChannel): LevelOrSilent | null {
  return channelLevels.get(channel) ?? null;
}

/**
 * Reset both global level and all per-channel overrides back to the
 * default ('debug', no overrides). Useful in tests; apps typically don't
 * need this.
 */
export function resetLogLevels(): void {
  currentLevel = 'debug';
  channelLevels.clear();
}

export interface ChannelLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  /**
   * Emit an error event. `err` may be an Error instance, a string, or any
   * unknown value caught from a try/catch — the dispatcher normalizes it
   * to an `ErrorInfo` so sinks see a consistent shape.
   */
  error(msg: string, err?: unknown, data?: Record<string, unknown>): void;
}

/**
 * Per-channel logger. Returns an object with `debug` / `info` / `warn` /
 * `error` methods that emit through the active sink with the channel
 * pre-bound. Framework packages call `const log = logger('runtime');` once
 * at module scope and reuse it.
 */
export function logger(channel: LogChannel): ChannelLogger {
  return {
    debug(msg, data) {
      if (!shouldEmit(channel, 'debug')) return;
      currentSink.emit({ ts: Date.now(), channel, level: 'debug', msg, data });
    },
    info(msg, data) {
      if (!shouldEmit(channel, 'info')) return;
      currentSink.emit({ ts: Date.now(), channel, level: 'info', msg, data });
    },
    warn(msg, data) {
      if (!shouldEmit(channel, 'warn')) return;
      currentSink.emit({ ts: Date.now(), channel, level: 'warn', msg, data });
    },
    error(msg, err, data) {
      if (!shouldEmit(channel, 'error')) return;
      currentSink.emit({
        ts: Date.now(),
        channel,
        level: 'error',
        msg,
        data,
        err: err === undefined ? undefined : normalizeError(err),
      });
    },
  };
}

function normalizeError(err: unknown): ErrorInfo {
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      cause: (err as Error & { cause?: unknown }).cause,
    };
  }
  return { message: String(err) };
}

export const PACKAGE_NAME = '@airo-js/log';
