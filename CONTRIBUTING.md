# Contributing to airo-js

Thanks for considering a contribution. Right now this repo is in `v0.0.x` scaffolding stage and the cartridge-kit contract is being validated against two skeletons (Dotter-WTB + Restaurant) — large API-surface PRs will likely be on hold until that contract stabilises.

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

Run from `airo-js/`:

```bash
pnpm -r --filter './packages/*' run build
cd packages/core && pnpm link --global
# (repeat for each package you want to consume)
```

Then in your consuming repo:

```bash
pnpm link --global @ai-ro/core
```

## What lands in this repo

- Rendering, lifecycle, style isolation, page routing, theme engine
- Cartridge-kit primitives (DataSource, View, MCP tool, Template)
- Embed bootstrap loader
- SSR dispatch (runtime-agnostic)

## What does NOT land here

- Auth, tenancy, drafts, history, locks, token rotation, the `/load` endpoint, RLS — these are studio concerns. See `airo-studio-v0-migration.md` (in `dotter-widget-studio`) decisions M9 + M13.
- Cartridge implementations themselves. Cartridges live in their consuming studio's repo (Dotter-WTB → `dotter-monorepo`; Restaurant → Airo studio in `dotter-widget-studio`).

## Code style

- TypeScript strict mode (already configured in `tsconfig.base.json`).
- No emojis in source code unless asked.
- Default to no comments. Add a comment only when the *why* is non-obvious — a hidden constraint, an invariant, a workaround for a specific bug.

## License

By contributing you agree your contribution is licensed under [Apache 2.0](./LICENSE).
