/**
 * Transformer — pure data shaping. Composed in the order declared on
 * `Cartridge.transformers[]`. Framework provides the chain orchestrator
 * (`TransformerPipeline` below) so all consumers — views, MCP tools,
 * publication adapters — read the same post-transformer snapshot.
 *
 * Shape is lifted verbatim from v1's RuntimePipeline (in dotter-monorepo),
 * widened from `(FeedData, WidgetConfig)` to `(TData, TConfig)`.
 */

import type { NavigationState } from '@ai-ro/core';

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
}

/**
 * Framework-owned pipeline orchestrator. The framework runs the transformer
 * chain before each render and the post-processor chain after each render.
 *
 * Pattern lifted from v1's RuntimePipeline. Cartridges declare
 * `transformers[]` + `postProcessors[]`; the framework orchestrates. This
 * means:
 *   1. ONE place transformer-chain semantics are defined (error policy,
 *      ordering, tracing).
 *   2. ONE place MCP tools and view renderers can subscribe to the
 *      post-transformer data — no chance of drift.
 *   3. Dev tooling (chain trace) is buildable framework-side.
 *
 * The highest-leverage framework-team decision in the proposal (§11).
 * Without this, MCP tools and publication adapters can't be guaranteed to
 * see the same data the rendered widget shows.
 */
export interface TransformerPipeline<TData, TConfig> {
  /** Transformer chain run on every render. */
  runTransformers(input: TData, ctx: TransformerContext<TConfig>): TData;

  /**
   * Optional dev tooling — when not in production, the framework can emit
   * a trace of which transformer changed what. Cartridges don't depend on
   * it; it's a debugging affordance.
   */
  enableTrace?(handler: (entry: TraceEntry) => void): void;
}

export interface TraceEntry {
  transformerName: string;
  inputSize: number;
  outputSize: number;
  durationMs: number;
}
