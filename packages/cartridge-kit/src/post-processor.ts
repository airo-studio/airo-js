/**
 * PostProcessor — side-effectful hooks, run after views render.
 *
 * Receive DOM + post-transformer data + event bus. Optional return =
 * teardown function (called on page unmount). Use for analytics hooks,
 * ARIA live regions, scroll restoration. NOT for data shaping — that's
 * what Transformer is for.
 *
 * Shape lifted verbatim from v1's RuntimePipeline.applyPostprocessors,
 * widened to (TData, TConfig).
 */

import type { IEventBus, NavigationState } from '@ai-ro/core';

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
  /** Returns optional teardown function — called on page unmount. */
  apply(ctx: PostProcessorContext<TData, TConfig>): void | (() => void);
}
