# TODOS

Work deliberately not done yet, with the trigger that would start it. Anything
that has a consumer waiting on it lives on the bridge, not here; anything that
is a decision already taken lives in `docs/designs/`. This file holds only the
follow-ups that have neither.

## Extract the demo OAuth provider into `examples/demo-oauth-provider`

**What:** a standalone stand-in identity provider (authorization code + PKCE,
one registered client, `demo` / `demo`) that other examples point
`AUTH_ISSUER` at, instead of the in-process router in
`examples/full-site/src/auth/oauth-provider.ts`.

**Why:** `full-site` would then read as "gate + relying party" only, and the
`shopify-edge-worker` example could reuse the provider the day it grows a
login without copying 200 lines.

**Context:** kept in-process now so `pnpm dev` runs alone with no second
process. The provider is already a self-contained Express router with no
import from the rest of the example except `DEMO_USER`, so the extraction is
mechanical. Decision D25 in `docs/designs/gate-reshape-0.11.md`.

**Trigger:** a second example that wants a login.
