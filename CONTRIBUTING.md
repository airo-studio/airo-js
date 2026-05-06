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

`yalc:push` is what you want 99% of the time — every consumer that ran `yalc add @ai-ro/...` picks up the new hash automatically, no second step.

`yalc:publish` is the manual variant: useful when you want to stage a new hash in the store without touching consumers (e.g. CI smoke-publishing, or a consumer mid-debug you don't want to disturb).

### From the consumer repo — pull updates

First time:

```bash
yalc add @ai-ro/core @ai-ro/runtime @ai-ro/ssr @ai-ro/embed @ai-ro/mcp @ai-ro/cartridge-kit
```

Subsequent updates: nothing to do if airo-js publisher used `pnpm yalc:push`. If they used `pnpm yalc:publish`, run `yalc update` to pull the latest store hash.

### When to switch to a real npm publish

Once cartridge-kit hits `0.2.0` (post-validation, see migration plan §Phase 0 done criteria), we publish to npm under the `@ai-ro` scope. Consumer repos then `pnpm install @ai-ro/core@^0.2` and stop using yalc for that package's surface. Yalc stays useful for `0.x` iteration on packages that aren't yet stable.

## What lands in this repo

- Rendering, lifecycle, style isolation, page routing, theme engine
- Cartridge-kit primitives (DataSource, View, MCP tool, Template)
- Embed bootstrap loader
- SSR dispatch (runtime-agnostic)

## What does NOT land here

- Auth, tenancy, drafts, history, locks, token rotation, load endpoints, row-level security — these are studio concerns. During the v0.0.x extraction window, see `airo-studio-v0-migration.md` (in `dotter-widget-studio`) for the migration decisions.
- Cartridge implementations themselves. Cartridges live in their consuming studio's repo. During the v0.0.x extraction, reference implementations live in private downstream codebases (`dotter-monorepo`, `dotter-widget-studio`); they are not redistributed here.

## Code style

- TypeScript strict mode (already configured in `tsconfig.base.json`).
- No emojis in source code unless asked.
- Default to no comments. Add a comment only when the *why* is non-obvious — a hidden constraint, an invariant, a workaround for a specific bug.

## License

By contributing you agree your contribution is licensed under [Apache 2.0](./LICENSE).
