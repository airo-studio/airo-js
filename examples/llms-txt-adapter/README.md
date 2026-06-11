# `llms-txt-adapter` — an AI-discovery manifest as one PublicationAdapter

A worked example showing that [`llms.txt`](https://llmstxt.org/) — the AI-era
sibling of `robots.txt`/`sitemap.xml` — is **not a convention you hand-maintain**
in `@airo-js`. It's one `PublicationAdapter`.

## What it does

`generate()` turns a post-Transformer store snapshot into the `llmstxt.org`
manifest format:

```text
# Example Outdoors

> Specialist trail and fell running kit.

## Categories

- [Trail Running](https://shop.example.com/c/trail-running): Grippy, lightweight shoes for off-road runs.

## Products

- [Fellraiser 2](https://shop.example.com/p/fellraiser-2): Aggressive 6mm-lug trail shoe for soft ground. (135 GBP, in stock)
```

`validate()` is a real hard gate — it blocks publish on a missing title, an
empty manifest, or a relative link, and warns on a missing summary blockquote.

## Why this matters

App frameworks document AI optimisation (LLMO / AIO / GEO) as a checklist:
*render server-side, hand-write JSON-LD, expose a feed, add `llms.txt`* — four
surfaces you keep in sync by discipline. `@airo-js` makes them **outputs of one
primitive off one snapshot**, so they can't drift:

| Surface | App-framework convention | `@airo-js` |
|---|---|---|
| Schema.org JSON-LD | hand-written `<script>` per route | `PublicationAdapter` `format: 'json-ld'` |
| Product / feed XML | author a server route | `PublicationAdapter` `format: 'xml'` |
| `llms.txt` | hand-maintain the file | **this example** — `format: 'custom'` |
| Agent-callable tools | (none — `llms.txt` is read-only) | `format: 'mcp-tools'` + `@airo-js/mcp` |

All four read the **same post-Transformer snapshot** the rendered widget reads
(the contract's *snapshot-fidelity* guarantee). The rendered price, the JSON-LD
price, the `llms.txt` price, and the MCP tool's answer are the same number by
construction — not by author vigilance.

See `docs/best-practices.md` §5.11 for the full AIO-vs-LLMO/SEO framing.

## Run

```bash
pnpm --filter @airo-js-examples/llms-txt-adapter typecheck
```

Compiles against `@airo-js/cartridge-kit`. `src/index.ts` ends with a `__demo`
that exercises `generate` + `validate` on a sample snapshot.
