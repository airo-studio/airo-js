/**
 * @ai-ro/core — runtime engine.
 *
 * Public surface used by @ai-ro/cartridge-kit, @ai-ro/runtime,
 * @ai-ro/ssr, and downstream consumers. Everything exported from here is
 * semver-stable for the package's major version.
 *
 * Phase 0 in flight: types are seeded from dotter-widget-studio's
 * `src/framework/`. Lifecycle (createApp, PageManager, Theme, IsolationRoot)
 * and the registry mailbox land in subsequent commits.
 */

export type {
  EventCallback,
  IEventBus,
} from './events.js';
export { EventBus } from './events.js';

export type {
  PageId,
  ComponentSettings,
  Slot,
  Region,
  PageLayout,
  Page,
  AppConfig,
} from './schema.js';

export type {
  NavigationState,
  SubpageActivation,
  RenderContext,
  PageRenderer,
  PageRendererFactory,
} from './page.js';

export const PACKAGE_NAME = '@ai-ro/core';
