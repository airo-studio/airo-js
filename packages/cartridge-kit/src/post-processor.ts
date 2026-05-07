/**
 * PostProcessor re-exports.
 *
 * The actual definitions live in `@airo-js/core` (paired with `RuntimePipeline`,
 * since the post-processor chain is part of the framework's render lifecycle).
 * Cartridges import via `@airo-js/cartridge-kit` for convenience — same names,
 * single source of truth.
 *
 * See `@airo-js/core/src/transformer.ts` for the contract details + design notes.
 */

export type {
  PostProcessor,
  PostProcessorContext,
} from '@airo-js/core';
