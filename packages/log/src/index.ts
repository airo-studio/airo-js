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
 *
 * The union is OPEN (0.3.0): the named members are the well-known
 * framework channels (kept for autocomplete), but any string is a valid
 * channel — `logger('analytics')`, `setChannelLevel('analytics', 'debug')`
 * and the `?airo-log=analytics:debug` grammar all work without the
 * framework blessing each host domain. `consoleSink` tags well-known
 * channels `[@airo-js/<channel>]` and app-defined ones bare `[<channel>]`
 * so host channels never print under framework branding.
 */
export type LogChannel =
  | 'core'
  | 'runtime'
  | 'embed'
  | 'ssr'
  | 'cartridge-kit'
  | 'mcp'
  /** Apps emit on this channel for their own structured events. */
  | 'app'
  | (string & {});

/** Channels owned by framework packages — used only for console tagging. */
const WELL_KNOWN_CHANNELS = new Set([
  'core',
  'runtime',
  'embed',
  'ssr',
  'cartridge-kit',
  'mcp',
  'app',
]);

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

// ─── Console formatting ─────────────────────────────────────────────
// Three payload formats for the console sink:
//   'clean' (default, 0.3.0) — deep-clone payloads as null-prototype
//     objects before they hit the console: DevTools renders them as
//     expandable objects with properties only, no `[[Prototype]]: Object`
//     row. The JSON round-trip also gives snapshot-at-log-time semantics
//     (the printed payload can't be mutated after the fact).
//   'json-pretty' (0.3.0) — render payloads as indented JSON.stringify
//     text INLINE, not a collapsed expandable object. For scanning a
//     stream of events, click-to-expand per line doesn't scale, and
//     copy/paste of a payload into a diff/ticket wants text (consumer
//     rsp_mryxzvt0 — the use case the initial YAGNI waited for).
//   'raw' — pass-through references, exactly the pre-0.3.0 behaviour.
// 'clean' and 'json-pretty' both fall back to the raw reference for any
// payload that doesn't survive JSON (circular structures, DOM nodes).

export type ConsoleFormat = 'clean' | 'json-pretty' | 'raw';

let consoleFormat: ConsoleFormat = 'clean';

/** Set the console payload format. Default `'clean'`; `'json-pretty'` prints indented text; `'raw'` restores pass-through references. */
export function setConsoleFormat(format: ConsoleFormat): void {
  consoleFormat = format;
}

/** Current console payload format. */
export function getConsoleFormat(): ConsoleFormat {
  return consoleFormat;
}

/**
 * Deep-clone a payload for console display: JSON round-trip with a
 * reviver that rebuilds plain objects as null-prototype (arrays stay
 * arrays). Falls back to the raw value when the structure doesn't
 * survive `JSON.stringify` (circular refs, BigInt, throwing getters).
 */
function cleanClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value), (_key, v) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.assign(Object.create(null), v)
        : v,
    );
  } catch {
    return value;
  }
}

/**
 * Format one payload arg per the active `ConsoleFormat`. Both 'clean'
 * and 'json-pretty' fall back to the raw reference when the value can't
 * be serialized (cleanClone handles this internally; JSON.stringify
 * throws on circular, caught here).
 */
function formatPayload(value: unknown): unknown {
  switch (consoleFormat) {
    case 'raw':
      return value;
    case 'json-pretty':
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return value;
      }
    case 'clean':
    default:
      return cleanClone(value);
  }
}

/**
 * Default sink — formats the event tag and dispatches to the matching
 * `console.*` method. Well-known framework channels tag as
 * `[@airo-js/<channel>]`; app-defined channels tag bare (`[<channel>]`)
 * so host domains never print under framework branding. Payloads pass
 * through the active `ConsoleFormat` (see above).
 */
export const consoleSink: AiroSink = {
  emit(event) {
    const scope = WELL_KNOWN_CHANNELS.has(event.channel) ? `@airo-js/${event.channel}` : event.channel;
    const tag = `[${scope}]${event.phase ? ` ${event.phase}` : ''}`;
    const args: unknown[] = [tag, event.msg];
    if (event.data) args.push(formatPayload(event.data));
    if (event.err) args.push(formatPayload(event.err));
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
// Default threshold is `'error'` (0.3.0 — was 'debug'): only genuine
// failures surface unprompted on any surface; info/warn narration is
// opt-in. The intended opt-in path is `?airo-log=<directive>` via
// `initLogControls` (persisted under `__airo_log`), or programmatic
// `setLogLevel`/`setChannelLevel`. SSR / Lambda contexts that want
// total quiet set `'silent'`.
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

/**
 * Default threshold: `'warn'`.
 *
 * 0.3.0 moved every scattered `console.*` call in the framework behind this
 * dispatcher and set the default to `'error'`, intending "narration is
 * opt-in". It overshot by one rank. `debug` and `info` ARE narration and
 * should stay off — but `warn` is not narration, it is "your configuration
 * is wrong and we are degrading", and setting the threshold above it
 * silenced every such message in the framework at once. Among them:
 * "Router init failed; URL routing disabled", "renderer does not implement
 * hydrate()", and both warns added in 0.9.0 specifically to stop silent
 * failures.
 *
 * Nothing fails when that happens, which is precisely the failure mode
 * this package exists to remove. A consumer measured it: the 0.9.0 warns
 * shipped and could not fire.
 *
 * `'warn'` also restores what the README has always claimed — that an app
 * which never calls `setSink` sees the pre-0.3.0 `console.warn` behaviour.
 *
 * Deliberately NOT conditional on `NODE_ENV`. This package runs in
 * browsers, Workers and Deno, where `process` does not exist; reading it
 * here would trade a visibility bug for a portability bug. A host that
 * wants production quiet calls `setLogLevel('error')`, which is one line
 * and explicit.
 */
const DEFAULT_LEVEL: LevelOrSilent = 'warn';

let currentLevel: LevelOrSilent = DEFAULT_LEVEL;
const channelLevels: Map<LogChannel, LevelOrSilent> = new Map();

function effectiveLevelFor(channel: LogChannel): LevelOrSilent {
  return channelLevels.get(channel) ?? currentLevel;
}

function shouldEmit(channel: LogChannel, level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[effectiveLevelFor(channel)];
}

/**
 * Would an event at `level` on `channel` pass the current threshold?
 * A single map-lookup + compare — cheap enough to guard a hot path.
 * Use it to skip building an expensive payload BEFORE calling the
 * logger, so the assembly cost is paid only when it will actually emit
 * (e.g. per-emission bus narration in `EventBus.emit`). The logger
 * methods run the same check internally, so this is a pure optimization,
 * never a correctness requirement.
 */
export function isLevelEnabled(channel: LogChannel, level: LogLevel): boolean {
  return shouldEmit(channel, level);
}

/**
 * Set the global log-level threshold. Events whose level is below
 * `level` are dropped. Default `'error'` (only genuine failures flow).
 * Channels with an explicit `setChannelLevel` override win over the
 * global.
 *
 *   setLogLevel('debug')   // dev: everything flows
 *   setLogLevel('warn')    // drop debug + info events
 *   setLogLevel('silent')  // SSR: drop everything
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
 * default ('error', no overrides). Useful in tests; apps typically don't
 * need this.
 */
export function resetLogLevels(): void {
  currentLevel = DEFAULT_LEVEL;
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

// ─── URL / storage log controls (0.3.0) ─────────────────────────────
// The `?airo-log=` convention, promoted from a consumer's runtime. With
// the default threshold at 'error', this is the intended opt-in path on
// any surface — reload with the param and you have chosen your output.
//
// Grammar (comma-separated directives, case-insensitive):
//   ?airo-log=debug              global level
//   ?airo-log=all | v | verbose  aliases for global debug
//   ?airo-log=off                global silent (the off-switch)
//   ?airo-log=analytics:debug    per-channel level (any channel string)
//   ?airo-log=analytics:v        per-channel verbose alias
//   ?airo-log=analytics          bare channel token → channel:debug
//   ?airo-log=warn,app:debug     combos; later directives win on conflict
// Two ergonomic rules keep the common reflexes from silently no-oping
// (consumer rsp_mryxzvt0):
//   - A bare token that is NOT a level alias is a channel → debug
//     (`analytics` == `analytics:debug`). A typo becomes a harmless
//     junk-channel level with nothing logging to it — never an error.
//   - A level alias in CHANNEL position (`all:v`, `debug:v`) is the
//     user's global intent, applied via setLogLevel — not a channel
//     literally named "all". The suffix is ignored (the alias already
//     carries the level).
//
// Persistence: when the URL param is present, the raw directive is
// written to `localStorage['__airo_log']` so it sticks across
// navigation and reloads. The key MUST stay a literal `__airo_`-prefixed
// string: sanitized-bundle contexts allowlist only literal `__airo_*`
// writes (which is also why persistence is overwrite-only — `off` is a
// stored directive, never a removeItem). When no param is present, the
// stored directive applies; the documented manual console convention
// `localStorage.setItem('airo-log', …)` is the read-only fallback when
// nothing was auto-persisted.

const LOG_PARAM = 'airo-log';
const LOG_STORAGE_KEY = '__airo_log';
const LOG_MANUAL_KEY = 'airo-log';

const LEVEL_ALIASES: Record<string, LevelOrSilent> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  silent: 'silent',
  off: 'silent',
  all: 'debug',
  v: 'debug',
  verbose: 'debug',
};

/**
 * Parse an `?airo-log=` directive string and apply it via
 * `setLogLevel` / `setChannelLevel`. Returns `true` when at least one
 * directive applied. Exported for hosts that transport the directive
 * some other way (config flag, postMessage); `initLogControls` is the
 * URL/storage wrapper most surfaces want.
 */
export function applyLogDirective(directive: string): boolean {
  let applied = false;
  for (const rawToken of directive.split(',')) {
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    const sep = token.indexOf(':');
    if (sep === -1) {
      // Bare token: level alias → global; anything else → channel:debug.
      const level = LEVEL_ALIASES[token];
      if (level) {
        setLogLevel(level);
      } else {
        setChannelLevel(token, 'debug');
      }
      applied = true;
      continue;
    }
    const head = token.slice(0, sep).trim();
    // Level alias in channel position → the user's global intent, not a
    // channel named after a level. Suffix ignored — the alias is the level.
    const headAsLevel = LEVEL_ALIASES[head];
    if (headAsLevel) {
      setLogLevel(headAsLevel);
      applied = true;
      continue;
    }
    const level = LEVEL_ALIASES[token.slice(sep + 1).trim()];
    if (head && level) {
      setChannelLevel(head, level);
      applied = true;
    }
  }
  return applied;
}

let logControlsInitialized = false;

/**
 * Read the `?airo-log=` URL param (falling back to the persisted
 * `__airo_log` key, then the manual `airo-log` console convention),
 * apply it, and persist URL-supplied directives so they stick across
 * reloads. No-op outside a browser context and after the first call
 * (`mountCartridge` invokes this on every mount; a host's programmatic
 * `setLogLevel` must not be clobbered by a second mount re-reading
 * storage). Safe under disabled storage (private mode) — the directive
 * still applies for the current page, it just doesn't persist.
 */
export function initLogControls(): void {
  if (logControlsInitialized) return;
  if (typeof window === 'undefined' || typeof location === 'undefined') return;
  logControlsInitialized = true;
  let directive: string | null = null;
  let fromUrl = false;
  try {
    directive = new URLSearchParams(location.search).get(LOG_PARAM);
    fromUrl = directive !== null;
  } catch {
    /* malformed search string — fall through to storage */
  }
  try {
    if (!fromUrl) {
      directive =
        localStorage.getItem(LOG_STORAGE_KEY) ?? localStorage.getItem(LOG_MANUAL_KEY);
    } else if (directive) {
      // LITERAL key at the write site — NOT `LOG_STORAGE_KEY`. Sanitized-
      // bundle consumers statically prove every `localStorage.setItem`
      // targets a literal `__airo_*` key; a const survives minification as
      // a variable and fails that proof (consumer rsp_mryxzvt0). Reads are
      // unrestricted, so the getItem calls above keep the const. Keep the
      // string in sync with LOG_STORAGE_KEY (one write site — low risk).
      localStorage.setItem('__airo_log', directive);
    }
  } catch {
    /* storage unavailable — apply without persistence */
  }
  if (directive) applyLogDirective(directive);
}

/** Reset the `initLogControls` once-guard. Test hook. */
export function resetLogControls(): void {
  logControlsInitialized = false;
}

export const PACKAGE_NAME = '@airo-js/log';
export const VERSION = '0.3.1';
