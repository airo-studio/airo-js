// @vitest-environment node
/**
 * RuntimePipelineImpl — the DataSource→Transformer→…→PostProcessor engine.
 *
 * 161 LOC that every cartridge's data passes through, and until 1.0 it had no
 * direct test. The cases here are the ones whose failure modes are silent:
 *
 *   - `errorPolicy: 'skip'` passing the INPUT through, not a partial result.
 *     §6 says never to use 'skip' for tenant-visibility filters, and the
 *     reason is that a skipped filter widens what a shopper can see. That
 *     only holds if 'skip' really is a passthrough.
 *   - LIFO teardown. A post-processor that owns a live region and one that
 *     scrolls to it must tear down in reverse construction order, or the
 *     second cleans up a thing the first already removed.
 *   - One throwing hook not taking down its siblings, in BOTH directions
 *     (apply and teardown).
 *   - The fast path. `!trace && policy === 'fail-render'` skips the try/catch
 *     entirely, so the traced and untraced paths are separate code and both
 *     need exercising — a bug in one is invisible from the other.
 */

import { describe, expect, test, vi } from 'vitest';

import { RuntimePipelineImpl, createPipeline } from '../src/runtime-pipeline.js';
import type { PostProcessor, TraceEntry, Transformer } from '../src/transformer.js';

interface Data {
  items: string[];
}
interface Config {
  on: boolean;
}

const ctx = { config: { on: true } as Config };

function transformer(over: Partial<Transformer<Data, Config>> = {}): Transformer<Data, Config> {
  return {
    name: 't',
    isEnabled: () => true,
    transform: (d) => d,
    ...over,
  };
}

function postProcessor(
  over: Partial<PostProcessor<Data, Config>> = {},
): PostProcessor<Data, Config> {
  return {
    name: 'p',
    isEnabled: () => true,
    apply: () => undefined,
    ...over,
  } as PostProcessor<Data, Config>;
}

const ppCtx = {
  container: null as unknown as HTMLElement,
  config: { on: true } as Config,
  data: { items: [] } as Data,
};

describe('runTransformers', () => {
  test('runs in declared order, threading each output into the next', async () => {
    const pipeline = createPipeline<Data, Config>([
      transformer({ name: 'a', transform: (d) => ({ items: [...d.items, 'a'] }) }),
      transformer({ name: 'b', transform: (d) => ({ items: [...d.items, 'b'] }) }),
      transformer({ name: 'c', transform: (d) => ({ items: [...d.items, 'c'] }) }),
    ]);

    const out = await pipeline.runTransformers({ items: [] }, ctx);
    expect(out.items).toEqual(['a', 'b', 'c']);
  });

  test('skips a disabled transformer without calling transform', async () => {
    const transform = vi.fn((d: Data) => d);
    const pipeline = createPipeline<Data, Config>([
      transformer({ isEnabled: () => false, transform }),
    ]);

    await pipeline.runTransformers({ items: [] }, ctx);
    expect(transform).not.toHaveBeenCalled();
  });

  test('isEnabled is asked with the config, not the data', async () => {
    const isEnabled = vi.fn(() => true);
    await createPipeline<Data, Config>([transformer({ isEnabled })]).runTransformers(
      { items: [] },
      ctx,
    );
    expect(isEnabled).toHaveBeenCalledWith(ctx.config);
  });

  test('awaits an async transformer (0.7+) alongside sync ones', async () => {
    const pipeline = createPipeline<Data, Config>([
      transformer({ name: 'sync', transform: (d) => ({ items: [...d.items, 's'] }) }),
      transformer({
        name: 'async',
        transform: async (d) => {
          await Promise.resolve();
          return { items: [...d.items, 'a'] };
        },
      }),
      transformer({ name: 'after', transform: (d) => ({ items: [...d.items, 'z'] }) }),
    ]);

    const out = await pipeline.runTransformers({ items: [] }, ctx);
    expect(out.items).toEqual(['s', 'a', 'z']);
  });

  test('an empty chain returns the input unchanged, by identity', async () => {
    const input = { items: ['x'] };
    await expect(createPipeline<Data, Config>([]).runTransformers(input, ctx)).resolves.toBe(input);
  });

  describe("errorPolicy 'fail-render' (the default)", () => {
    test('propagates a sync throw', async () => {
      const pipeline = createPipeline<Data, Config>([
        transformer({
          transform: () => {
            throw new Error('boom');
          },
        }),
      ]);

      await expect(pipeline.runTransformers({ items: [] }, ctx)).rejects.toThrow('boom');
    });

    test('propagates a rejected promise identically', async () => {
      const pipeline = createPipeline<Data, Config>([
        transformer({ transform: () => Promise.reject(new Error('async boom')) }),
      ]);

      await expect(pipeline.runTransformers({ items: [] }, ctx)).rejects.toThrow('async boom');
    });

    test('is the default when errorPolicy is omitted', async () => {
      const t = transformer();
      expect(t.errorPolicy).toBeUndefined();
      const pipeline = createPipeline<Data, Config>([
        transformer({
          transform: () => {
            throw new Error('default policy');
          },
        }),
      ]);
      await expect(pipeline.runTransformers({ items: [] }, ctx)).rejects.toThrow('default policy');
    });

    test('stops the chain — later transformers do not run', async () => {
      const later = vi.fn((d: Data) => d);
      const pipeline = createPipeline<Data, Config>([
        transformer({
          transform: () => {
            throw new Error('stop');
          },
        }),
        transformer({ name: 'later', transform: later }),
      ]);

      await expect(pipeline.runTransformers({ items: [] }, ctx)).rejects.toThrow();
      expect(later).not.toHaveBeenCalled();
    });
  });

  describe("errorPolicy 'skip'", () => {
    test('passes the INPUT through untouched — not a partial result', async () => {
      // The §6 rule "never 'skip' a tenant-visibility filter" depends on this
      // being a true passthrough. A partial result would be worse than either
      // failing or passing through.
      const input = { items: ['original'] };
      const pipeline = createPipeline<Data, Config>([
        transformer({
          errorPolicy: 'skip',
          transform: () => {
            throw new Error('nope');
          },
        }),
      ]);

      const out = await pipeline.runTransformers(input, ctx);
      expect(out).toEqual({ items: ['original'] });
    });

    test('the chain continues, and later transformers see the passthrough', async () => {
      const pipeline = createPipeline<Data, Config>([
        transformer({ name: 'a', transform: (d) => ({ items: [...d.items, 'a'] }) }),
        transformer({
          name: 'boom',
          errorPolicy: 'skip',
          transform: () => {
            throw new Error('nope');
          },
        }),
        transformer({ name: 'c', transform: (d) => ({ items: [...d.items, 'c'] }) }),
      ]);

      const out = await pipeline.runTransformers({ items: [] }, ctx);
      expect(out.items).toEqual(['a', 'c']);
    });

    test('applies identically to a rejected promise', async () => {
      const pipeline = createPipeline<Data, Config>([
        transformer({ errorPolicy: 'skip', transform: () => Promise.reject(new Error('async')) }),
      ]);

      await expect(pipeline.runTransformers({ items: ['keep'] }, ctx)).resolves.toEqual({
        items: ['keep'],
      });
    });
  });

  describe('tracing', () => {
    test('reports one entry per ENABLED transformer, named', async () => {
      const entries: TraceEntry[] = [];
      const pipeline = createPipeline<Data, Config>(
        [
          transformer({ name: 'a' }),
          transformer({ name: 'disabled', isEnabled: () => false }),
          transformer({ name: 'b' }),
        ],
        [],
        { traceHandler: (e) => entries.push(e) },
      );

      await pipeline.runTransformers({ items: [] }, ctx);
      expect(entries.map((e) => e.transformerName)).toEqual(['a', 'b']);
    });

    test('enableTrace() attaches a handler after construction', async () => {
      const entries: TraceEntry[] = [];
      const pipeline = createPipeline<Data, Config>([transformer({ name: 'a' })]);

      await pipeline.runTransformers({ items: [] }, ctx);
      expect(entries).toHaveLength(0);

      pipeline.enableTrace((e) => entries.push(e));
      await pipeline.runTransformers({ items: [] }, ctx);
      expect(entries.map((e) => e.transformerName)).toEqual(['a']);
    });

    test('measures an array by length and an object by JSON size', async () => {
      const entries: TraceEntry[] = [];
      const pipeline = createPipeline<Data, Config>(
        [transformer({ transform: (d) => ({ items: [...d.items, 'x'] }) })],
        [],
        { traceHandler: (e) => entries.push(e) },
      );

      await pipeline.runTransformers({ items: ['a'] }, ctx);
      // Data is an object, so both sizes are JSON lengths and the output is
      // the larger of the two.
      expect(entries[0]!.outputSize).toBeGreaterThan(entries[0]!.inputSize);
      expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('reports -1 for data that cannot be stringified', async () => {
      const entries: TraceEntry[] = [];
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      const pipeline = createPipeline<Record<string, unknown>, Config>(
        [{ name: 't', isEnabled: () => true, transform: (d) => d }],
        [],
        { traceHandler: (e) => entries.push(e) },
      );

      await pipeline.runTransformers(circular, ctx);
      expect(entries[0]!.inputSize).toBe(-1);
    });

    test('a traced fail-render throw still propagates', async () => {
      // Tracing moves execution off the fast path into the try/catch, so the
      // two paths are separate code. Both must propagate.
      const pipeline = createPipeline<Data, Config>(
        [
          transformer({
            transform: () => {
              throw new Error('traced boom');
            },
          }),
        ],
        [],
        { traceHandler: () => {} },
      );

      await expect(pipeline.runTransformers({ items: [] }, ctx)).rejects.toThrow('traced boom');
    });

    test('a traced skip still emits its trace entry', async () => {
      const entries: TraceEntry[] = [];
      const pipeline = createPipeline<Data, Config>(
        [
          transformer({
            name: 'skipper',
            errorPolicy: 'skip',
            transform: () => {
              throw new Error('x');
            },
          }),
        ],
        [],
        { traceHandler: (e) => entries.push(e) },
      );

      await pipeline.runTransformers({ items: [] }, ctx);
      expect(entries.map((e) => e.transformerName)).toEqual(['skipper']);
    });
  });
});

describe('runPostProcessors', () => {
  test('applies enabled processors in order and skips disabled ones', () => {
    const order: string[] = [];
    const pipeline = createPipeline<Data, Config>(
      [],
      [
        postProcessor({ name: 'a', apply: () => void order.push('a') }),
        postProcessor({ name: 'off', isEnabled: () => false, apply: () => void order.push('off') }),
        postProcessor({ name: 'b', apply: () => void order.push('b') }),
      ],
    );

    pipeline.runPostProcessors(ppCtx);
    expect(order).toEqual(['a', 'b']);
  });

  test('tears down LIFO — reverse of construction', () => {
    const order: string[] = [];
    const pipeline = createPipeline<Data, Config>(
      [],
      [
        postProcessor({ name: 'a', apply: () => () => void order.push('a') }),
        postProcessor({ name: 'b', apply: () => () => void order.push('b') }),
        postProcessor({ name: 'c', apply: () => () => void order.push('c') }),
      ],
    );

    pipeline.runPostProcessors(ppCtx)();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  test('a processor returning no teardown is simply not torn down', () => {
    const order: string[] = [];
    const pipeline = createPipeline<Data, Config>(
      [],
      [
        postProcessor({ name: 'a', apply: () => () => void order.push('a') }),
        postProcessor({ name: 'none', apply: () => undefined }),
        postProcessor({ name: 'c', apply: () => () => void order.push('c') }),
      ],
    );

    pipeline.runPostProcessors(ppCtx)();
    expect(order).toEqual(['c', 'a']);
  });

  test('one throwing apply does not stop its siblings', () => {
    const order: string[] = [];
    const pipeline = createPipeline<Data, Config>(
      [],
      [
        postProcessor({ name: 'a', apply: () => void order.push('a') }),
        postProcessor({
          name: 'boom',
          apply: () => {
            throw new Error('apply failed');
          },
        }),
        postProcessor({ name: 'c', apply: () => void order.push('c') }),
      ],
    );

    expect(() => pipeline.runPostProcessors(ppCtx)).not.toThrow();
    expect(order).toEqual(['a', 'c']);
  });

  test('one throwing teardown does not stop the remaining teardowns', () => {
    const order: string[] = [];
    const pipeline = createPipeline<Data, Config>(
      [],
      [
        postProcessor({ name: 'a', apply: () => () => void order.push('a') }),
        postProcessor({
          name: 'boom',
          apply: () => () => {
            throw new Error('teardown failed');
          },
        }),
        postProcessor({ name: 'c', apply: () => () => void order.push('c') }),
      ],
    );

    const teardown = pipeline.runPostProcessors(ppCtx);
    expect(() => teardown()).not.toThrow();
    // 'c' tears down first (LIFO), 'boom' throws, 'a' still runs.
    expect(order).toEqual(['c', 'a']);
  });

  test('a processor that threw during apply contributes no teardown', () => {
    const order: string[] = [];
    const pipeline = createPipeline<Data, Config>(
      [],
      [
        postProcessor({
          name: 'boom',
          apply: () => {
            order.push('applied');
            throw new Error('half-constructed');
          },
        }),
      ],
    );

    pipeline.runPostProcessors(ppCtx)();
    expect(order).toEqual(['applied']);
  });

  test('an empty chain yields a callable no-op teardown', () => {
    expect(() => createPipeline<Data, Config>([], []).runPostProcessors(ppCtx)()).not.toThrow();
  });

  test('postProcessors default to [] when the factory is given only transformers', () => {
    expect(() => createPipeline<Data, Config>([]).runPostProcessors(ppCtx)()).not.toThrow();
  });
});

describe('createPipeline', () => {
  test('returns a RuntimePipelineImpl', () => {
    expect(createPipeline<Data, Config>([])).toBeInstanceOf(RuntimePipelineImpl);
  });
});
