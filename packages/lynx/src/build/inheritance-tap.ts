/**
 * Switch on CSS inheritance for vanilla Lynx bundles, and prove it happened.
 *
 * Lynx does not inherit `color`, `font-*` or `line-height` into `<text>`
 * unless the bundle's page config says `enableCSSInheritance: true`. With it
 * off, 39 of 43 text elements on the spike page were black and every line
 * box was 16px; with it on, 42 of 43 matched the browser.
 *
 * `@lynx-js/vanilla-rsbuild-plugin` (0.1.x) registers the template plugin
 * under the chain name `lynx:vanilla:template:<entry>` and forwards only
 * `targetSdkVersion` to it, so `pluginLynx({ enableCSSInheritance: true })`
 * does not reach the bundle. This taps that chain entry's arguments instead.
 * The name is internal to a 0.1.x package, so a rename would silently drop
 * inheritance. Two assertions turn that into a failed build: at least one
 * template plugin must be patched, and every emitted bundle that carries the
 * page config must carry the flag set to true.
 *
 * The clean fix is upstream: the vanilla plugin forwarding the template
 * plugin's CSS options. Until then, this.
 */

/** The chain-entry prefix the vanilla plugin uses for its template plugins. */
export const TEMPLATE_PLUGIN_PREFIX = 'lynx:vanilla:template:';

/** The subset of rspack-chain this needs, so the tap can be tested without a build. */
export interface ChainLike {
  plugins: { store: Map<string, unknown> };
  plugin(name: string): { tap(fn: (args: unknown[]) => unknown[]): unknown };
}

export interface InheritanceOptions {
  /**
   * Extra properties to inherit beyond Lynx's default inherited set, for
   * a page that relies on `text-align` or `letter-spacing` cascading.
   */
  customCSSInheritanceList?: string[];
}

export class InheritanceTapError extends Error {
  constructor(message: string) {
    super(`[@airo-js/lynx] ${message}`);
    this.name = 'InheritanceTapError';
  }
}

/**
 * Merge the inheritance options into every vanilla template plugin on the
 * chain. Throws when there is none to patch: the vanilla plugin is missing,
 * registered after this one, or renamed its chain entry.
 */
export function tapCssInheritance(chain: ChainLike, environment: string, options: InheritanceOptions = {}): number {
  let patched = 0;
  for (const name of chain.plugins.store.keys()) {
    if (!name.startsWith(TEMPLATE_PLUGIN_PREFIX)) continue;
    chain.plugin(name).tap(([opts, ...rest]) => [
      {
        ...(opts as Record<string, unknown>),
        enableCSSInheritance: true,
        ...(options.customCSSInheritanceList ? { customCSSInheritanceList: options.customCSSInheritanceList } : {}),
      },
      ...rest,
    ]);
    patched++;
  }
  if (patched === 0) {
    const names = [...chain.plugins.store.keys()].join(', ') || '(none)';
    throw new InheritanceTapError(
      `no "${TEMPLATE_PLUGIN_PREFIX}<entry>" template plugin in the "${environment}" build, so CSS inheritance cannot be switched on and text would lose its colour and line height on device. Register pluginVanillaLynx() in the same config. If it is there, @lynx-js/vanilla-rsbuild-plugin has renamed its chain entry; chain plugins seen: ${names}.`,
    );
  }
  return patched;
}

const FLAG = /"enableCSSInheritance"\s*:\s*(true|false)/g;

/**
 * Every emitted `.bundle` that carries the page config must carry
 * `"enableCSSInheritance":true`, and at least one must. Returns the bundles
 * checked; throws naming the ones that fail.
 */
export function assertInheritanceInBundles(assets: { name: string; source: Uint8Array | string }[]): string[] {
  const bundles = assets.filter((a) => a.name.endsWith('.bundle'));
  const off: string[] = [];
  const on: string[] = [];
  for (const asset of bundles) {
    const text = typeof asset.source === 'string' ? asset.source : Buffer.from(asset.source).toString('latin1');
    const values = [...text.matchAll(FLAG)].map((m) => m[1]);
    if (values.length === 0) continue;
    if (values.every((v) => v === 'true')) on.push(asset.name);
    else off.push(asset.name);
  }
  if (off.length) {
    throw new InheritanceTapError(
      `CSS inheritance is off in ${off.join(', ')} although the template plugin was patched. Text on device would lose its colour and line height.`,
    );
  }
  if (bundles.length && on.length === 0) {
    throw new InheritanceTapError(
      `none of the emitted bundles (${bundles.map((b) => b.name).join(', ')}) carries "enableCSSInheritance":true.`,
    );
  }
  return on;
}
