# TODOS

Work deliberately not done yet, with the trigger that would start it. Anything
that has a consumer waiting on it lives on the bridge, not here; anything that
is a decision already taken lives in `docs/designs/`. This file holds only the
follow-ups that have neither.

## Runtime

### Abort an in-flight mount on destroy(), and thread an AbortSignal into DataSource.fetch

**What:** `mountCartridge` gets an `AbortController` per mount attempt: `destroy()` during an in-flight remount (gate phase or data phase) aborts it, the attempt discards the App it would have produced, and `ds.fetch` receives `ctx.signal`.

**Why:** Today `result.destroy()` during a remount's async gate phase or fetch destroys the already-destroyed handle and the remount then completes — router listeners attach, renderers paint, nothing tears them down. The gate phase made the window "however long a visitor leaves a modal open". The runtime also never supplies `ctx.signal`, so cartridges that thread it through (the convention) get `undefined`.

**Context:** Surfaced by the 0.11.0 pre-landing adversarial review. A `destroyed` flag checked after each `await` in `doMountInner` plus one controller per attempt; ~30 LOC in `packages/runtime/src/mount-cartridge.ts`. The convention "always thread `ctx.signal`" in best-practices §1.2 is written as if the runtime supplied one.

**Effort:** M
**Priority:** P2
**Depends on:** None

### Make the runtime's entry resolution authoritative for PageManager

**What:** `createApp` / `PageManager` accept the runtime's already-resolved `MountEntry` and skip their own URL re-parse, so the page the gates were scoped against is the page that mounts by construction.

**Why:** The gate phase is async and the URL can change under it; today the runtime narrates a disagreement (`log.warn`, phase `'gate'`) but cannot prevent it. The docblock claim "by construction" was corrected to describe the narration.

**Context:** `resolveMountEntry` in `packages/core/src/mount-entry.ts` is shared by both sides; what is missing is a way for `PageManager`'s constructor to take the result instead of recomputing it. Changes a core constructor's options — a 1.0 shape question.

**Effort:** M
**Priority:** P2
**Depends on:** 1.0 surface review

## SSR

### Let renderAppWithPublication take the snapshot lazily

**What:** `snapshot: TData | (() => Promise<TData>)`, resolved only after the entry-resolution and private/csr-only decisions, so a private refusal never touches it.

**Why:** The two-call "refuse first, then ask who is asking" host shape builds the public snapshot and a Document before the first call, which for a private entry is a refusal that reads neither. With an in-memory DataSource that is nothing; with a real one every anonymous or bot hit on a private URL is an upstream fetch.

**Context:** `examples/full-site/src/server.ts` already builds the Document lazily inside its `render` closure; the snapshot cannot be, because the runner's option is a value. Surfaced by the 0.11.0 performance specialist.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Examples

### Extract the demo OAuth provider into `examples/demo-oauth-provider`

**What:** A standalone stand-in identity provider (authorization code + PKCE, one registered client, `demo` / `demo`) that other examples point `AUTH_ISSUER` at, instead of the in-process router in `examples/full-site/src/auth/oauth-provider.ts`.

**Why:** `full-site` would then read as "gate + relying party" only, and the `shopify-edge-worker` example could reuse the provider the day it grows a login without copying 200 lines.

**Context:** Kept in-process now so `pnpm dev` runs alone with no second process. The provider is already a self-contained Express router whose only import from the rest of the example is `DEMO_USER`, so the extraction is mechanical. Decision D25 in `docs/designs/gate-reshape-0.11.md`.

**Effort:** M
**Priority:** P3
**Depends on:** A second example that wants a login

## Completed
