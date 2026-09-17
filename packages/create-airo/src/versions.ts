/**
 * The @airo-js versions every template names, one entry per package.
 *
 * Hand-maintained on purpose, and gated by `test/versions.test.ts`, which
 * fails the moment an entry disagrees with the matching
 * `packages/<name>/package.json` in this repo. That is the same posture as
 * `scripts/publish.sh`'s VERSION-const gate: a hardcoded value plus a check,
 * rather than a build step that stamps it.
 *
 * Why not derive these from this package's own `VERSION`: the packages are
 * not in lockstep. `@airo-js/log` has its own line, and a single package can
 * take a patch the rest of the line does not. Every derived scheme is wrong
 * for at least one entry, and a wrong entry is a range that does not resolve
 * on the user's first `npm install`.
 *
 * Templates write the whole spec as one placeholder (`"__V_CORE__"`), and it
 * renders as `^<version>` by default. Under 0.x a caret takes patches on the
 * same line and stops at the next minor, so a project scaffolded now picks up
 * `0.11.x` fixes and stays on 0.11 when the next line ships. It needs
 * migrating then; it does not break. `--exact` renders `<version>` instead,
 * for teams whose rule is to pin a pre-1.0 framework exactly.
 */
export const AIRO_VERSIONS = {
  '@airo-js/core': '0.11.0',
  '@airo-js/cartridge-kit': '0.11.0',
  '@airo-js/runtime': '0.11.1',
  '@airo-js/ssr': '0.11.1',
  '@airo-js/embed': '0.11.0',
  '@airo-js/mcp': '0.11.0',
  '@airo-js/log': '0.3.1',
} as const;

const SCOPE = '@airo-js/';

/**
 * The placeholder a template writes for a package's version spec, without
 * the surrounding underscores: `@airo-js/cartridge-kit` → `V_CARTRIDGE_KIT`,
 * so a template's package.json reads
 * `"@airo-js/cartridge-kit": "__V_CARTRIDGE_KIT__"`.
 */
export function versionToken(pkg: string): string {
  const bare = pkg.startsWith(SCOPE) ? pkg.slice(SCOPE.length) : pkg;
  return `V_${bare.toUpperCase().replace(/-/g, '_')}`;
}

/** Every version placeholder with its spec, ready for `render()`. */
export function versionVars(opts: { exact?: boolean } = {}): Record<string, string> {
  const prefix = opts.exact ? '' : '^';
  const vars: Record<string, string> = {};
  for (const [pkg, version] of Object.entries(AIRO_VERSIONS)) {
    vars[versionToken(pkg)] = `${prefix}${version}`;
  }
  return vars;
}

/** The minor line the templates target, for the banner: `0.11`. */
export function targetLine(): string {
  return AIRO_VERSIONS['@airo-js/core'].split('.').slice(0, 2).join('.');
}
