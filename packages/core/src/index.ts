/**
 * @ai-ro/core — runtime engine.
 *
 * Public surface used by @ai-ro/cartridge-kit, @ai-ro/runtime,
 * @ai-ro/ssr, and downstream consumers. Everything exported from here is
 * semver-stable for the package's major version.
 *
 * Phase 0 in flight. Surface today:
 *   - createApp + App lifecycle FSM
 *   - PageManager (mediator at the framework's core)
 *   - EventBus + IEventBus
 *   - HashRouter (URL ↔ NavState bridge)
 *   - Breadcrumb (data-driven navigation trail)
 *   - createRegistry + pushToMailbox (stub-queue plugin self-registration)
 *   - Transformer + PostProcessor + RuntimePipeline (pipeline orchestration)
 *   - Page / AppConfig / Slot / Region schema types
 *   - PageRenderer / RenderContext / NavigationState contract
 *
 * Pending: Theme + IsolationRoot (WU#5).
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

export type {
  Transformer,
  TransformerContext,
  PostProcessor,
  PostProcessorContext,
  RuntimePipeline,
  TraceEntry,
} from './transformer.js';

/** @deprecated v0.2-rc.2 — use `RuntimePipeline`. Alias kept one minor version. */
export type { TransformerPipeline } from './transformer.js';

export { RuntimePipelineImpl, createPipeline } from './runtime-pipeline.js';

export type {
  RouteState,
  RouterOnNavigate,
  IHashRouter,
  HashRouterOptions,
} from './router.js';
export { HashRouter } from './router.js';

export type {
  Crumb,
  LabelResolver,
  BreadcrumbHandle,
  MountBreadcrumbOptions,
} from './breadcrumb.js';
export {
  buildCrumbs,
  renderCrumbsHtml,
  attachClickHandlers,
  mountBreadcrumb,
} from './breadcrumb.js';

export type { PageManagerOptions } from './page-manager.js';
export { PageManager } from './page-manager.js';

export type {
  AppLifecycleState,
  AppDeps,
  App,
} from './app.js';
export { createApp } from './app.js';

export type {
  RegistryEntry,
  Registry,
} from './registry.js';
export { createRegistry, pushToMailbox } from './registry.js';

export const PACKAGE_NAME = '@ai-ro/core';
