/**
 * What `pluginAiroLynx()` does to the build's config. Each line here was a
 * card that would not start on device: framework code the main-thread
 * compiler could not read, or a vendor chunk neither thread could load.
 */

import type { RsbuildConfig, RsbuildPlugin, RsbuildPluginAPI } from '@rsbuild/core';
import { describe, expect, it, vi } from 'vitest';

import { pluginAiroLynx } from '../src/build/plugin.js';

/** Run the plugin's config hook over `config` and return it. */
function apply(config: RsbuildConfig): { config: RsbuildConfig } {
  let modify: ((c: RsbuildConfig) => void) | undefined;
  const api = {
    logger: { warn: vi.fn(), info: vi.fn() },
    modifyRsbuildConfig: (fn: (c: RsbuildConfig) => void) => {
      modify = fn;
    },
    transform: vi.fn(),
    modifyBundlerChain: vi.fn(),
    onAfterEnvironmentCompile: vi.fn(),
  } as unknown as RsbuildPluginAPI;
  (pluginAiroLynx() as RsbuildPlugin).setup(api);
  modify!(config);
  return { config };
}

const includes = (config: RsbuildConfig, path: string): boolean =>
  (config.source?.include ?? []).some((rule) => rule instanceof RegExp && rule.test(path));

describe('pluginAiroLynx config', () => {
  it('transpiles the framework packages from node_modules, and nothing else of node_modules', () => {
    const { config } = apply({});
    expect(includes(config, '/app/node_modules/@airo-js/core/dist/index.js')).toBe(true);
    expect(includes(config, 'C:\\app\\node_modules\\@airo-js\\lynx\\dist\\runtime\\index.js')).toBe(true);
    expect(includes(config, '/app/node_modules/left-pad/index.js')).toBe(false);
  });

  it('keeps includes the card already had', () => {
    const own = /[\\/]node_modules[\\/]some-lib[\\/]/;
    const { config } = apply({ source: { include: [own] } });
    expect(config.source?.include?.[0]).toBe(own);
    expect(config.source?.include).toHaveLength(2);
  });

  it('turns chunk splitting off, whichever option asked for it', () => {
    expect(apply({}).config.splitChunks).toBe(false);
    const asked = apply({ splitChunks: { preset: 'default' }, performance: { chunkSplit: { strategy: 'split-by-experience' } } });
    expect(asked.config.splitChunks).toBe(false);
    expect(asked.config.performance?.chunkSplit).toBeUndefined();
  });

  it('turns CSS minification off and leaves JavaScript minification as it was', () => {
    expect(apply({ output: { minify: { js: true } } }).config.output?.minify).toEqual({ js: true, css: false });
    expect(apply({ output: { minify: false } }).config.output?.minify).toBe(false);
  });
});
