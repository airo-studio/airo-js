/**
 * DataSource — how a cartridge loads its data shape.
 *
 * Each cartridge declares one or more sources (PDF drop, CSV upload, feed
 * URL, OAuth-connected service). The host app renders the matching
 * onboarding affordance from the discriminated `onboardingShape`. The
 * cartridge owns the `fetch` implementation; the host app decides caching
 * policy.
 */

/**
 * Discriminated union of onboarding affordances. Host apps switch on
 * `kind` to render the right UI. Extending requires a contract change —
 * for v0 we keep the union closed and revisit when an unanticipated
 * `kind` shows up.
 */
export type DataSourceOnboardingShape =
  | { kind: 'url-input'; placeholder?: string; validate?: (url: string) => boolean }
  | { kind: 'file-upload'; accept: string }
  | { kind: 'oauth-connect'; provider: string }
  | { kind: 'sheet'; columns: string[] }
  /** Host-app-side mapping for kinds not yet first-class. */
  | { kind: 'custom'; descriptor: string };

/**
 * Discriminated union of inputs the host app passes to `fetch`. Mirrors
 * `DataSourceOnboardingShape` — the host app collected this input via
 * the matching affordance.
 */
export type DataSourceInput =
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: File }
  | { kind: 'oauth-token'; token: string }
  | { kind: 'sheet'; sheetId: string }
  | { kind: 'custom'; payload: unknown };

export interface DataSourceContext<TConfig> {
  config: TConfig;
  /** Threaded from the cartridge's secrets store, if the host app supports one. */
  credentials?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DataSource<TData, TConfig = unknown> {
  id: string;
  displayName: string;

  /** Host-app-side affordance the user sees during onboarding. */
  onboardingShape: DataSourceOnboardingShape;

  /** Async load — cancellable via AbortSignal. Host apps decide caching. */
  fetch(input: DataSourceInput, ctx: DataSourceContext<TConfig>): Promise<TData>;

  /** Optional cache key derivation — host apps use as advisory only. */
  cacheKey?(input: DataSourceInput): string;

  /** TTL hint — cartridge advice; host app decides actual cache policy. */
  cacheTtlMs?: number;
}
