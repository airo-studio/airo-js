/**
 * DataSource — how a cartridge loads its data shape.
 *
 * Each cartridge declares one or more sources (PDF drop, CSV upload, feed
 * URL, OAuth-connected service). The studio renders the matching onboarding
 * affordance from the discriminated `onboardingShape`. The cartridge owns
 * the `fetch` implementation; the studio decides caching policy.
 */

/**
 * Discriminated union of onboarding affordances. Studios switch on `kind`
 * to render the right UI. Extending requires a contract change — open
 * question in the proposal (§9 discussion). For v0 we keep the union
 * closed and revisit when an unanticipated `kind` shows up.
 */
export type DataSourceOnboardingShape =
  | { kind: 'url-input'; placeholder?: string; validate?: (url: string) => boolean }
  | { kind: 'file-upload'; accept: string }
  | { kind: 'oauth-connect'; provider: string }
  | { kind: 'sheet'; columns: string[] }
  /** Studio-side mapping for kinds not yet first-class. */
  | { kind: 'custom'; descriptor: string };

/**
 * Discriminated union of inputs the studio passes to `fetch`. Mirrors
 * `DataSourceOnboardingShape` — the studio collected this input via the
 * matching affordance.
 */
export type DataSourceInput =
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: File }
  | { kind: 'oauth-token'; token: string }
  | { kind: 'sheet'; sheetId: string }
  | { kind: 'custom'; payload: unknown };

export interface DataSourceContext<TConfig> {
  config: TConfig;
  /** Threaded from cartridge's secrets store, if the studio supports one. */
  credentials?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DataSource<TData, TConfig = unknown> {
  id: string;
  displayName: string;

  /** Studio-side affordance the user sees during onboarding. */
  onboardingShape: DataSourceOnboardingShape;

  /** Async load — cancellable via AbortSignal. Studios decide caching. */
  fetch(input: DataSourceInput, ctx: DataSourceContext<TConfig>): Promise<TData>;

  /** Optional cache key derivation — studios use as advisory only. */
  cacheKey?(input: DataSourceInput): string;

  /** TTL hint — cartridge advice; studio decides actual cache policy. */
  cacheTtlMs?: number;
}
