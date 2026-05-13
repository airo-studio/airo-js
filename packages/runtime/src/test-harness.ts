/**
 * Test harness — mount a cartridge in-memory against a fixture feed.
 *
 * For cartridge authors writing a `cartridge.test.ts` that asserts their
 * cartridge mounts correctly with NO studio context. The structural M13
 * guarantee comes from the export surface: this module re-exports ONLY
 * `mountCartridgeInMemory` + its option/result types. A test file that
 * imports from `@airo-js/runtime/test-harness` + its own cartridge module
 * cannot pull in studio shell types (`ShellHandle`, `MountPhase`,
 * `SharedLifecycleHooks`) — the boundary is the export surface, not magic.
 *
 * Usage:
 *
 * ```ts
 * import { mountCartridgeInMemory } from '@airo-js/runtime/test-harness';
 * import { myCartridge } from '../src/cartridge.js';
 *
 * test('mounts with fixture feed', async () => {
 *   const { dom, pipelineSnapshot, cleanup } = await mountCartridgeInMemory({
 *     cartridge: myCartridge,
 *     config: myCartridge.defaultConfig,
 *     fixtureFeed: { items: ['a', 'b'] },
 *   });
 *   expect(dom).toContain('expected-marker');
 *   expect(pipelineSnapshot.items).toHaveLength(2);
 *   cleanup();
 * });
 * ```
 *
 * Style isolation defaults to `'light'` so `dom` is observable directly
 * without traversing a shadow root. Pass `styleIsolation: 'shadow'`
 * explicitly if you need to test shadow-DOM-specific behaviour.
 */

import type { Cartridge, Template } from '@airo-js/cartridge-kit';
import type { StyleIsolation } from '@airo-js/core';

import { mountCartridge } from './mount-cartridge.js';

export interface MountInMemoryOptions<TData, TConfig> {
  /** Cartridge under test. Must have at least one template. */
  cartridge: Cartridge<TData, TConfig>;
  /** Config the cartridge mounts with. Often `cartridge.defaultConfig`. */
  config: TConfig;
  /**
   * Data fed directly into the pipeline. Bypasses `DataSource.fetch` —
   * the harness asserts cartridges work with a given feed shape, not
   * that their network code is correct.
   */
  fixtureFeed: TData;
  /**
   * Template to mount. Defaults to the template whose `id` matches
   * `cartridge.defaultTemplateId`, falling back to `templates[0]`.
   * Throws when the cartridge declares no templates at all.
   */
  template?: Template<TConfig>;
  /**
   * Style isolation mode. Default: `'light'` (DOM is observable in
   * `result.dom` without shadow-root traversal). Pass `'shadow'` to
   * test shadow-DOM-specific behaviour — `result.dom` will then read
   * from the shadow root's `innerHTML`.
   */
  styleIsolation?: StyleIsolation;
  /**
   * DOM environment. Defaults to `globalThis.document`. Vitest with
   * `environment: 'happy-dom'` (or jsdom) provides this automatically;
   * pass explicitly only when running outside a configured test runner.
   */
  document?: Document;
}

export interface MountInMemoryResult<TData> {
  /** Rendered HTML inside the cartridge's render root. */
  dom: string;
  /**
   * Post-Transformer snapshot — exactly the value views, MCP tools,
   * and PublicationAdapters consume. Use this to assert transformer
   * correctness independent of view markup.
   */
  pipelineSnapshot: TData;
  /** Tear down the mount and remove the in-memory host element. */
  cleanup: () => void;
}

export async function mountCartridgeInMemory<TData, TConfig>(
  opts: MountInMemoryOptions<TData, TConfig>,
): Promise<MountInMemoryResult<TData>> {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (!doc) {
    throw new Error(
      '[@airo-js/runtime/test-harness] No `document` available. Pass `opts.document` explicitly, or run in a DOM-capable test environment (vitest with `environment: "happy-dom"`).',
    );
  }

  const template =
    opts.template ??
    opts.cartridge.templates.find((t) => t.id === opts.cartridge.defaultTemplateId) ??
    opts.cartridge.templates[0];
  if (!template) {
    throw new Error(
      `[@airo-js/runtime/test-harness] Cartridge "${opts.cartridge.id}" declares no templates. Add at least one template before testing the mount.`,
    );
  }

  const isolation: StyleIsolation = opts.styleIsolation ?? 'light';
  const host = doc.createElement('div');
  doc.body.appendChild(host);

  let pipelineSnapshot: TData | undefined;
  const result = await mountCartridge({
    cartridge: opts.cartridge,
    config: opts.config,
    template,
    host,
    preloadedData: opts.fixtureFeed,
    styleIsolation: isolation,
    onPipelineComplete: (snapshot) => {
      pipelineSnapshot = snapshot;
    },
  });

  if (result.blocked) {
    host.remove();
    throw new Error(
      `[@airo-js/runtime/test-harness] Cartridge "${opts.cartridge.id}" mount was blocked by gate "${result.blockedBy}". Disable the gate or stub it for this fixture.`,
    );
  }

  if (pipelineSnapshot === undefined) {
    // Pipeline runs synchronously before mount completes; this branch
    // should be unreachable. Guard anyway so the result type is non-optional.
    result.destroy();
    host.remove();
    throw new Error(
      '[@airo-js/runtime/test-harness] Pipeline snapshot was not captured — internal invariant violated. Please file a bug.',
    );
  }

  return {
    dom: result.shell.renderRoot.innerHTML,
    pipelineSnapshot,
    cleanup: () => {
      result.destroy();
      host.remove();
    },
  };
}
