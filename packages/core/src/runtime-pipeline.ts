/**
 * RuntimePipelineImpl — the default `RuntimePipeline` implementation.
 *
 * Iterates the transformer chain in declared order; iterates the
 * post-processor chain similarly; collects teardowns in a stack so unmount
 * runs them in reverse order (LIFO).
 *
 * Why this lives in @airo-js/core (not in @airo-js/cartridge-kit): pipeline
 * orchestration is rendering, and rendering belongs to the framework.
 * cartridge-kit re-exports the types but never the impl.
 *
 * Host apps can use this directly via `createPipeline(transformers, postProcessors)`
 * or implement their own `RuntimePipeline<TData, TConfig>` if they need
 * different semantics (e.g. async support before v0.3).
 */

import { logger } from '@airo-js/log';

import type {
  PostProcessor,
  PostProcessorContext,
  RuntimePipeline,
  TraceEntry,
  Transformer,
  TransformerContext,
} from './transformer.js';

const log = logger('core');

interface PipelineOptions {
  /**
   * Optional trace handler — when set, every transformer's input/output
   * size and execution time is reported. Cartridges don't depend on it;
   * dev tools attach it. `enableTrace()` after construction sets it too.
   */
  traceHandler?: (entry: TraceEntry) => void;
}

export class RuntimePipelineImpl<TData, TConfig> implements RuntimePipeline<TData, TConfig> {
  private traceHandler: ((entry: TraceEntry) => void) | undefined;

  constructor(
    private readonly transformers: ReadonlyArray<Transformer<TData, TConfig>>,
    private readonly postProcessors: ReadonlyArray<PostProcessor<TData, TConfig>>,
    opts: PipelineOptions = {},
  ) {
    this.traceHandler = opts.traceHandler;
  }

  runTransformers(input: TData, ctx: TransformerContext<TConfig>): TData {
    let data = input;
    for (const t of this.transformers) {
      if (!t.isEnabled(ctx.config)) continue;

      // Hot path — no tracing, no try/catch unless errorPolicy demands it.
      const policy = t.errorPolicy ?? 'fail-render';
      const trace = this.traceHandler;

      if (!trace && policy === 'fail-render') {
        // Fast path: production default — propagate errors, no measurement.
        data = t.transform(data, ctx);
        continue;
      }

      const inSize = trace ? this.measure(data) : 0;
      const t0 = trace ? performance.now() : 0;
      try {
        data = t.transform(data, ctx);
      } catch (err) {
        if (policy === 'fail-render') {
          // Re-throw — caller (PageManager) catches and shows an error UI.
          throw err;
        }
        // 'skip' — log and pass input through untouched. Don't widen
        // visibility silently if a config/data shape changes.
        log.error(
          `Transformer "${t.name}" threw with errorPolicy='skip'; passing input through.`,
          err,
          { transformer: t.name, phase: 'pipeline' },
        );
      }
      if (trace) {
        trace({
          transformerName: t.name,
          inputSize: inSize,
          outputSize: this.measure(data),
          durationMs: performance.now() - t0,
        });
      }
    }
    return data;
  }

  runPostProcessors(ctx: PostProcessorContext<TData, TConfig>): () => void {
    const teardowns: Array<() => void> = [];
    for (const p of this.postProcessors) {
      if (!p.isEnabled(ctx.config)) continue;
      try {
        const teardown = p.apply(ctx);
        if (typeof teardown === 'function') {
          teardowns.push(teardown);
        }
      } catch (err) {
        // Post-processors are side-effect hooks; one failing should not
        // tear down the others. Log and continue.
        log.error(`PostProcessor "${p.name}" threw during apply; continuing.`, err, {
          postProcessor: p.name,
          phase: 'post-process',
        });
      }
    }
    // Aggregate teardown — LIFO so destruction order mirrors construction.
    return () => {
      for (let i = teardowns.length - 1; i >= 0; i--) {
        try {
          teardowns[i]!();
        } catch (err) {
          log.error('PostProcessor teardown threw; continuing.', err, { phase: 'post-process-teardown' });
        }
      }
    };
  }

  enableTrace(handler: (entry: TraceEntry) => void): void {
    this.traceHandler = handler;
  }

  /**
   * Cheap heuristic — Array.length on top-level arrays, fall back to
   * JSON.stringify().length for objects. Only ever called when tracing
   * is enabled, so the cost is opt-in.
   */
  private measure(data: TData): number {
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') {
      try {
        return JSON.stringify(data).length;
      } catch {
        return -1;
      }
    }
    return 0;
  }
}

/**
 * Factory shorthand. Host apps and cartridges typically don't construct
 * the class directly — they call `createPipeline` with the cartridge's
 * `transformers[]` and `postProcessors[]`.
 */
export function createPipeline<TData, TConfig>(
  transformers: ReadonlyArray<Transformer<TData, TConfig>>,
  postProcessors: ReadonlyArray<PostProcessor<TData, TConfig>> = [],
  opts: PipelineOptions = {},
): RuntimePipeline<TData, TConfig> {
  return new RuntimePipelineImpl(transformers, postProcessors, opts);
}
