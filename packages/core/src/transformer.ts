/**
 * Transformer + RuntimePipeline — runtime-side primitives the framework
 * orchestrates. Cartridges declare `transformers[]` + `postProcessors[]`;
 * the framework runs them through a `RuntimePipeline` so all consumers
 * (views, MCP tools, publication adapters) read the SAME post-Transformer
 * snapshot.
 *
 * Why these types live in `@airo-js/core` and not in `@airo-js/cartridge-kit`:
 * pipeline orchestration IS rendering. The framework is rendering-only, so
 * the runtime types belong in `@airo-js/core`. `@airo-js/cartridge-kit`
 * re-exports them for cartridge-author convenience — same names, single
 * source of truth.
 *
 * Notes for cartridge authors:
 *   - **Sync only at v0.** Async support deferred to a future minor; an
 *     async transformer would block render. Pre-compute async work in
 *     DataSource (which returns `Promise<TData>`) when possible.
 *   - **Shape-preserving only.** `transform: TData → TData`. Reshape
 *     upstream in `DataSource.fetch` instead of pivoting mid-pipeline.
 */

import type { NavigationState } from './page.js';
import type { IEventBus } from './events.js';

export interface TransformerContext<TConfig> {
  config: TConfig;
  /** Selected category etc. narrows the visible data. */
  navState: NavigationState;
  locale?: string;
}

export interface Transformer<TData, TConfig = unknown> {
  /** Stable identifier — used in dev tooling traces. */
  name: string;
  isEnabled(config: TConfig): boolean;
  /** Pure: data → data. No side effects. */
  transform(data: TData, ctx: TransformerContext<TConfig>): TData;

  /**
   * What the orchestrator does when `transform` throws.
   *   - `'fail-render'` (default): error propagates up; render path breaks.
   *     Pick this when a broken transform should block the entire widget
   *     rather than emit subtly-wrong data.
   *   - `'skip'`: log the error and pass the input data through untouched.
   *     Pick this for transforms whose absence degrades gracefully (sort,
   *     enrichment) but never for filters whose absence widens the data
   *     past a tenant's configured visibility.
   */
  errorPolicy?: 'fail-render' | 'skip';
}

export interface PostProcessorContext<TData, TConfig> {
  container: HTMLElement;
  config: TConfig;
  /** POST-transformer — same data the rendered views show. */
  data: TData;
  events: IEventBus;
  navState: NavigationState;
}

export interface PostProcessor<TData, TConfig = unknown> {
  name: string;
  isEnabled(config: TConfig): boolean;
  /** Returns optional teardown function — collected by the pipeline. */
  apply(ctx: PostProcessorContext<TData, TConfig>): void | (() => void);
}

/**
 * Framework-owned pipeline orchestrator. Runs transformer chain before
 * each render and post-processor chain after each render.
 *
 * Three contract guarantees this enables:
 *   1. ONE place pipeline semantics are defined (error policy, ordering,
 *      tracing, teardown collection).
 *   2. ONE place MCP tools and view renderers can subscribe to the
 *      post-transformer data — no chance of drift.
 *   3. Dev tooling (chain trace) is buildable framework-side.
 */
export interface RuntimePipeline<TData, TConfig> {
  /** Transformer chain run on every render. */
  runTransformers(input: TData, ctx: TransformerContext<TConfig>): TData;

  /**
   * PostProcessor chain run after view mount. Each post-processor's
   * optional teardown is collected; the returned aggregate teardown
   * runs every collected teardown in reverse order on page unmount.
   */
  runPostProcessors(ctx: PostProcessorContext<TData, TConfig>): () => void;

  /**
   * Optional dev tooling — when not in production, the framework can emit
   * a trace of which transformer changed what.
   */
  enableTrace(handler: (entry: TraceEntry) => void): void;
}

/**
 * @deprecated v0.2-rc.2 — renamed to `RuntimePipeline` to reflect that the
 * orchestrator covers both transformer and post-processor chains. Type
 * alias kept for one minor version so v0.2-rc.1 consumers don't break.
 */
export type TransformerPipeline<TData, TConfig> = RuntimePipeline<TData, TConfig>;

export interface TraceEntry {
  transformerName: string;
  inputSize: number;
  outputSize: number;
  durationMs: number;
}
