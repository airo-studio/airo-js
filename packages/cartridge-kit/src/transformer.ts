/**
 * Transformer + RuntimePipeline re-exports.
 *
 * The actual definitions live in `@ai-ro/core` because pipeline orchestration
 * is rendering, and rendering is the framework's job (M13). Cartridges import
 * via `@ai-ro/cartridge-kit` for convenience — same names, single source of
 * truth.
 *
 * See `@ai-ro/core/src/transformer.ts` for the contract details + design notes.
 */

export type {
  Transformer,
  TransformerContext,
  RuntimePipeline,
  TraceEntry,
} from '@ai-ro/core';

/** @deprecated v0.2-rc.2 — renamed to `RuntimePipeline`. Type alias kept for one minor version. */
export type { TransformerPipeline } from '@ai-ro/core';
