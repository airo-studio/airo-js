/**
 * @airo-js/core — runtime engine.
 *
 * Public surface used by @airo-js/cartridge-kit, @airo-js/runtime,
 * @airo-js/ssr, and downstream consumers. Everything exported from here is
 * semver-stable for the package's major version.
 *
 * Surface:
 *   - createApp + App lifecycle FSM
 *   - PageManager (mediator at the framework's core)
 *   - EventBus + IEventBus
 *   - HashRouter (URL ↔ NavState bridge)
 *   - buildCrumbs (data-only navigation trail helper — cartridges render)
 *   - createRegistry + pushToMailbox (stub-queue plugin self-registration)
 *   - Transformer + PostProcessor + RuntimePipeline (pipeline orchestration)
 *   - Theme (CSS variable injection + customCSS)
 *   - IsolationRoot strategies (none / partial / full shadow DOM)
 *   - Page / AppConfig / Slot / Region schema types
 *   - PageRenderer / RenderContext / NavigationState contract
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
  UpdateResult,
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
  IRouter,
  /** @deprecated 0.5.0 — alias for `IRouter`. */
  IHashRouter,
  RouterOption,
  HashRouterOptions,
  QueryRouterOptions,
  DecodeNavParamsOptions,
} from './router.js';
export { HashRouter, QueryRouter, routerHrefFor, decodeNavParams } from './router.js';

export type { PathRouterOptions } from './path-router.js';
export { PathRouter } from './path-router.js';

export type {
  NavEncodingOptions,
  NavDecodeOptions,
} from './nav-encoding.js';
export {
  stateToFragment,
  fragmentToState,
  decodeNavHint,
  extractPathTail,
} from './nav-encoding.js';

export type {
  Crumb,
  LabelResolver,
} from './breadcrumb.js';
export { buildCrumbs } from './breadcrumb.js';

export type { PageManagerOptions } from './page-manager.js';
export { PageManager, findEntryPage, resolveEntryPage } from './page-manager.js';

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

export type { ThemeOptions } from './theme.js';
export { Theme } from './theme.js';

export type {
  StyleIsolation,
  IsolationRoot,
} from './style.js';
export {
  setupIsolationRoot,
  wrapInShadow,
  resolveStyleRoot,
} from './style.js';

export { parseHtml, parseHtmlFragment } from './parse-html.js';

export const PACKAGE_NAME = '@airo-js/core';
