/**
 * Drop views from a cartridge whose `capabilities` mark them as
 * server-unsafe. Pair with `renderAppWithPublication` to give
 * server-side entry points a single import + single helper call
 * instead of a hand-rolled spread-and-filter that's easy to get
 * wrong (lose generics, miss future capabilities, drift from the
 * `ViewDefinition.capabilities` declarations).
 *
 *   import { filterServerSafeCartridge, renderAppWithPublication }
 *     from '@airo-js/ssr';
 *   import { myCartridge } from '@my-org/my-cartridge';
 *
 *   const serverSafe = filterServerSafeCartridge(myCartridge);
 *   const result = await renderAppWithPublication({
 *     cartridge: serverSafe,
 *     // ...
 *   });
 *
 * The helper composes with the framework's existing csr-only gate in
 * `renderAppWithPublication`: a view that survives the filter and is
 * still encountered at SSR time (via mailbox registration or unfiltered
 * import) still goes through the runtime's capability check before
 * dispatch. Two layers, same source of truth: the `capabilities` array
 * on `ViewDefinition`.
 *
 * Defaults: excludes views tagged `'csr-only'`. Override via
 * `options.excludeCapabilities` for cartridges that need additional
 * capability gates at the SSR boundary (e.g. `'requires-auth'` views
 * that should never anonymously SSR).
 *
 * Limitations:
 *   - Operates on the static `views[]` array only. Mailbox-registered
 *     factories (`pushToMailbox(cartridge.mailboxName, ...)`) carry no
 *     capability metadata at this layer; cartridges that need the gate
 *     for mailbox-only views must ship a `ViewDefinition` placeholder
 *     in `views[]` with `capabilities` set.
 */

import type { Cartridge } from '@airo-js/cartridge-kit';

export interface FilterServerSafeCartridgeOptions {
  /**
   * Capability tags whose presence on a `ViewDefinition.capabilities`
   * array causes the view to be excluded from the returned cartridge.
   * Default: `['csr-only']`.
   *
   * Extending this is how new server-unsafe capabilities reach
   * cartridge authors without code change in the cartridge itself —
   * the framework can extend the default in a future release and every
   * caller automatically picks up the broader filter.
   */
  excludeCapabilities?: ReadonlyArray<string>;
}

const DEFAULT_EXCLUDE: ReadonlyArray<string> = ['csr-only'];

/**
 * Return a cartridge whose `views[]` excludes any view declaring a
 * `capabilities` tag in `excludeCapabilities`. Preserves all other
 * cartridge fields (transformers, data sources, MCP tools, publication
 * adapters, schema, templates, etc.) and the full
 * `<TData, TConfig, TStyles>` generics — type inference for downstream
 * `renderAppWithPublication` calls stays intact.
 */
export function filterServerSafeCartridge<
  TData,
  TConfig,
  TStyles,
>(
  cartridge: Cartridge<TData, TConfig, TStyles>,
  options: FilterServerSafeCartridgeOptions = {},
): Cartridge<TData, TConfig, TStyles> {
  const exclude = new Set(options.excludeCapabilities ?? DEFAULT_EXCLUDE);
  return {
    ...cartridge,
    views: cartridge.views.filter(
      (v) => !v.capabilities?.some((c) => exclude.has(c)),
    ),
  };
}
