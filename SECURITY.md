# Security

## Reporting a vulnerability

Please report security issues privately to **security@airo.dev** (placeholder — TBD before publishing). Do not open a public GitHub issue for vulnerabilities.

We aim to acknowledge reports within 3 business days and provide a remediation timeline within 7 days for confirmed issues.

## Trust posture

`airo-js` is a rendering substrate that runs in end-user browsers. The threat model lives in the consuming application, not here, but a few invariants the framework upholds:

- **No data exfiltration paths in the framework.** Core renders config + feed; it does not initiate network calls beyond what cartridges explicitly declare via DataSourceAdapter.
- **Style isolation strategies are the boundary** between widget CSS and host page CSS — `partial` and `full` modes attach a Shadow DOM. `none` is opt-out and documented.
- **No secrets in framework code.** API keys, tokens, signed bundles are host-app concerns.

## Signed-bundle work

A signed-bundle / Ed25519 spike exists in a private downstream codebase but is **not** loaded in v0. Path C work stays a spike and does not block v0.

When signed bundles do ship, they will land as a separate `@airo-js/runtime-verifier` package alongside the L1/L2 sanitiser, with its own threat-model doc and an explicit release note.
