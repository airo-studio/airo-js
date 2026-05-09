# `@airo-js/log`

Sink-based structured event logging for the airo-js framework. Replaces scattered `console.*` calls across `@airo-js/*` packages with a single dispatcher; apps replace the sink to feed events into devtools panels, Sentry, Datadog, or stay with the default console behaviour.

> Status: **v0.1.0**. Stable surface. Layer 1 of the framework devtools story (the dispatcher + structured event types). A separate `@airo-js/devtools` panel that consumes the sink will follow.

## What this is

A dependency-free leaf package that the rest of `@airo-js/*` emits into:

- **`logger(channel)`** — returns a `ChannelLogger` with `debug` / `info` / `warn` / `error` methods. Framework packages call this at module scope.
- **`AiroEvent`** — structured event shape (timestamp, channel, level, message, optional phase / widgetId / cartridgeId / data / error).
- **`AiroSink`** — `{ emit(event): void }`. Replaceable.
- **`consoleSink`** (default) — preserves existing `[@airo-js/<channel>] <msg>` console behaviour verbatim.
- **`noopSink`** — for tests.
- **`setSink` / `getSink` / `resetSink`** — sink management.

## Why a sink

Three real consumer needs the framework couldn't address before:

1. **Forward framework lifecycle events to existing observability** — Sentry breadcrumbs, Datadog logs, OpenTelemetry spans. Without the sink, every consumer would have to monkey-patch `console`.
2. **In-page devtools panels** — a panel subscribes to events and renders a live stream / state inspector. The sink is the panel's data source.
3. **Test noise control** — replace the sink with `noopSink` in unit tests so framework warnings don't flood test output.

## Default behaviour: identical to today

```ts
// @airo-js/embed today (post-retrofit):
import { logger } from '@airo-js/log';
const log = logger('embed');

log.warn(`'${elementName}' already registered; skipping.`);
// → console.warn('[@airo-js/embed]', "'<name>' already registered; skipping.")
```

The default `consoleSink` produces output indistinguishable from the previous `console.warn('[@airo-js/embed] ...')` lines. Apps that never call `setSink` see zero behavioural change.

## Replacing the sink

```ts
import { setSink, type AiroSink } from '@airo-js/log';

const sentrySink: AiroSink = {
  emit(event) {
    Sentry.addBreadcrumb({
      category: `airo:${event.channel}`,
      level: event.level,
      message: event.msg,
      data: { ...event.data, phase: event.phase, widgetId: event.widgetId },
    });
    if (event.level === 'error' && event.err) {
      Sentry.captureException(new Error(event.err.message));
    }
  },
};

setSink(sentrySink);
```

Or multiplex — log to console *and* capture to a ring buffer for the devtools panel:

```ts
import { consoleSink, setSink, type AiroEvent } from '@airo-js/log';

const ringBuffer: AiroEvent[] = [];
const RING_SIZE = 500;

setSink({
  emit(event) {
    consoleSink.emit(event);
    ringBuffer.push(event);
    if (ringBuffer.length > RING_SIZE) ringBuffer.shift();
  },
});

// ringBuffer is the data source for the devtools panel.
```

## Channel taxonomy

| Channel | Source |
|---|---|
| `core` | `@airo-js/core` (event bus, page manager, pipeline, router) |
| `runtime` | `@airo-js/runtime` |
| `embed` | `@airo-js/embed` |
| `ssr` | `@airo-js/ssr` |
| `cartridge-kit` | `@airo-js/cartridge-kit` |
| `mcp` | `@airo-js/mcp` |
| `app` | Apps emit their own structured events on this channel |

The `phase` field is free-form — typical values: `'shell' | 'gate' | 'fetch' | 'pipeline' | 'mount'` for runtime mount lifecycle, page ids for navigation, gate ids for blocked-by-X warnings.

## What this is NOT

- Not a replacement for thrown errors — throws still propagate to the caller via promise rejection / try-catch. The sink is for *side-channel* observability (warnings, recoverable errors, lifecycle phases that don't throw).
- Not a metrics or telemetry pipeline — sinks can forward to one, but this package doesn't ship the forwarding logic.
- Not a logger framework with formatters / appenders / log4j-style hierarchies — it's a single sink with structured events. Complexity belongs in the sink implementation, not the dispatcher.

## License

Apache-2.0 — same as the rest of `@airo-js/*`.
