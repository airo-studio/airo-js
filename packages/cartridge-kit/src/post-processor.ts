/**
 * PostProcessor re-exports.
 *
 * The actual definitions live in `@ai-ro/core` (paired with `RuntimePipeline`,
 * since the post-processor chain is part of the framework's render lifecycle
 * per M13). Cartridges import via `@ai-ro/cartridge-kit` for convenience —
 * same names, single source of truth.
 *
 * See `@ai-ro/core/src/transformer.ts` for the contract details + design notes.
 */

export type {
  PostProcessor,
  PostProcessorContext,
} from '@ai-ro/core';
