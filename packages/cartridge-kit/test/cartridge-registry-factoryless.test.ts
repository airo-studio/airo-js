/**
 * `createCartridgeRegistry` and a factory-less `views[]` entry (0.11.0).
 *
 * `getDefaultRenderResolver` has its own test for the fall-through; the
 * registry's two resolution paths (`resolveView` and `resolverFor`) carry
 * the same branch and are exercised here directly: a capability-only entry
 * resolves nothing before the chunk registers and the chunk's factory
 * after, on both paths.
 */

import { afterEach, describe, expect, test } from 'vitest';
import { pushToMailbox } from '@airo-js/core';

import type { Cartridge } from '../src/cartridge.js';
import { createCartridgeRegistry } from '../src/cartridge-registry.js';

const mailboxes: string[] = [];
let counter = 0;

function uniqueMailbox(): string {
  const name = `__AIRO_REGISTRY_FACTORYLESS_${counter++}__`;
  mailboxes.push(name);
  return name;
}

afterEach(() => {
  for (const name of mailboxes.splice(0)) {
    delete (globalThis as Record<string, unknown>)[name];
  }
});

function buildCartridge(mailboxName: string): Cartridge {
  return {
    id: 'factoryless',
    mailboxName,
    industry: 'test',
    displayName: 'Factory-less',
    description: 'fixture',
    version: '0.0.0',
    schema: {
      parse: (input) => input,
      safeParse: (input) => ({ success: true as const, data: input }),
    },
    dataSources: [],
    // Capability-only: the page type is declared `csr-only`, the chunk
    // registers the factory later through the mailbox.
    views: [{ id: 'connect-view', displayName: 'Connect', pageType: 'connect', capabilities: ['csr-only'] }],
    templates: [],
    defaultConfig: {},
    defaultTemplateId: 'main',
  };
}

describe('createCartridgeRegistry — a factory-less views[] entry', () => {
  test('resolveView() falls through to the mailbox instead of shadowing it', () => {
    const mailbox = uniqueMailbox();
    const registry = createCartridgeRegistry([buildCartridge(mailbox)]);
    const factory = () => ({ render() {}, destroy() {} });

    expect(registry.resolveView('factoryless', 'connect')).toBeUndefined();
    pushToMailbox(mailbox, { key: 'connect', factory });
    expect(registry.resolveView('factoryless', 'connect')).toBe(factory);
  });

  test('resolverFor() falls through to the mailbox on the same entry', () => {
    const mailbox = uniqueMailbox();
    const registry = createCartridgeRegistry([buildCartridge(mailbox)]);
    const factory = () => ({ render() {}, destroy() {} });
    const resolve = registry.resolverFor('factoryless');

    expect(resolve('connect')).toBeUndefined();
    pushToMailbox(mailbox, { key: 'connect', factory });
    expect(resolve('connect')).toBe(factory);
  });
});
