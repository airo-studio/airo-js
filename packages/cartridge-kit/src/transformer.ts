/**
 * Transformer + RuntimePipeline re-exports.
 *
 * The actual definitions live in `@airo-js/core` because pipeline orchestration
 * is rendering, and rendering is the framework's job. Cartridges import
 * via `@airo-js/cartridge-kit` for convenience — same names, single source of
 * truth.
 *
 * See `@airo-js/core/src/transformer.ts` for the contract details + design notes.
 */

export type {
  Transformer,
  TransformerContext,
  RuntimePipeline,
  TraceEntry,
} from '@airo-js/core';

/** @deprecated v0.2-rc.2 — renamed to `RuntimePipeline`. Type alias kept for one minor version. */
export type { TransformerPipeline } from '@airo-js/core';
