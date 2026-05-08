# Contributing to airo-js

Thanks for considering a contribution. Right now this repo is in `v0.0.x` scaffolding stage and the cartridge-kit contract is being validated against representative cartridge skeletons — large API-surface PRs will likely be on hold until that contract stabilises.

## Local development

Prereqs:
- Node ≥ 20
- pnpm ≥ 9 (use `corepack enable pnpm` if you don't have it)

```bash
git clone <repo>
cd airo-js
pnpm install
pnpm typecheck
pnpm build
```

## Linking into a downstream repo for development

We use **[yalc](https://github.com/wclr/yalc)** for local linking, not `pnpm link`. Yalc copies the published shape of each package into the consumer's `node_modules` (vs symlinking source), which avoids:

- TypeScript resolution surprises with `workspace:*` protocol crossing repo boundaries
- Pre-`dist/`-built imports leaking into the consumer's bundler
- Stale type definitions when the source has new exports the consumer doesn't see

Install yalc once globally:

```bash
npm i -g yalc
```

### From `airo-js/` — push to consumers

Two scripts, mirroring yalc's own verbs:

```bash
pnpm yalc:push       # build + yalc push  → store + auto-update every linked consumer
pnpm yalc:publish    # build + yalc publish → store only; consumers run `yalc update`
```

`yalc:push` is what you want 99% of the time — every consumer that ran `yalc add @airo-js/...` picks up the new hash automatically, no second step.

`yalc:publish` is the manual variant: useful when you want to stage a new hash in the store without touching consumers (e.g. CI smoke-publishing, or a consumer mid-debug you don't want to disturb).

### From the consumer repo — pull updates

First time:

```bash
yalc add @airo-js/core @airo-js/runtime @airo-js/ssr @airo-js/embed @airo-js/mcp @airo-js/cartridge-kit
```

Subsequent updates: nothing to do if airo-js publisher used `pnpm yalc:push`. If they used `pnpm yalc:publish`, run `yalc update` to pull the latest store hash.

### yalc vs npm

Stable releases are published to npm under the `@airo-js` scope; consume them via `pnpm add @airo-js/core` etc. Use yalc only when iterating on a not-yet-released change locally and you want a downstream consumer to pick it up before publish.

## What lands in this repo

- Rendering, lifecycle, style isolation, page routing, theme engine
- Cartridge-kit primitives (DataSource, View, MCP tool, Template, PublicationAdapter, Gate)
- Embed bootstrap loader
- SSR dispatch (runtime-agnostic)

## What does NOT land here

- Auth, tenancy, drafts, history, locks, token rotation, load endpoints, row-level security — these are host-app concerns and live outside the framework.
- Cartridge implementations themselves. Cartridges live in the consuming application's own repository, not here.

## Code style

- TypeScript strict mode (already configured in `tsconfig.base.json`).
- No emojis in source code unless asked.
- Default to no comments. Add a comment only when the *why* is non-obvious — a hidden constraint, an invariant, a workaround for a specific bug.

## License

By contributing you agree your contribution is licensed under [Apache 2.0](./LICENSE).
