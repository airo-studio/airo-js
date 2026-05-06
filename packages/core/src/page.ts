/**
 * PageRenderer contract + navigation types.
 *
 * Strategy pattern at the framework's core: each `page.type` resolves to
 * a registered PageRenderer factory. The mediator (PageManager) never
 * branches on type; it asks the registry and dispatches. Adding a new
 * page type means registering a new factory, not touching framework code.
 *
 * Generic over an opaque `TAppContext` bag so domain apps can pass through
 * whatever data they like (feeds, themes, retailer lists, etc.) without
 * the framework knowing about it.
 */

import type { Page, PageId } from './schema.js';
import type { IEventBus } from './events.js';

/**
 * Navigation state — a Composite key for the active anchor page plus
 * optional context (selected category, active product, …). Subpages
 * (modals, drawers) ride on the same shape via their `parent` link in the
 * Page schema, so the renderer for the parent page is the one that gets
 * `activateSubpage` called.
 */
export interface NavigationState {
  page: PageId;
  /** Free-form context narrowed by the consumer app. */
  [key: string]: string | undefined;
}

export interface SubpageActivation<TPageType extends string = string> {
  type: TPageType;
  id: PageId;
  parent: PageId;
  [key: string]: string | undefined;
}

/**
 * Render-time bag handed to a PageRenderer. The PageManager builds this
 * fresh on every navigate; renderers don't cache it.
 *
 * `events` is the App-level EventBus — every renderer in the same App
 * shares the same bus, so a FilterBar in a categories page can emit
 * `category:selected` and a different page's renderer (instantiated
 * after navigation) can subscribe and react.
 */
export interface RenderContext<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  page: Page<TPageType>;
  app: TAppContext;
  events: IEventBus;
  navState: NavigationState;
  navigate: (state: Partial<NavigationState>) => void;
}

/**
 * The contract every page implementation satisfies. `render` is required;
 * everything else is opt-in. Renderers are stateless factories — the
 * registry stores a `() => PageRenderer` callable so each navigation gets
 * a fresh instance whose lifetime matches one page mount.
 *
 * SSR + hydrate are optional: a renderer that doesn't implement them
 * works fine in CSR-only Apps. Apps that go through `renderAppToHTML`
 * or `createApp({ hydrate: true })` need the active page's renderer to
 * implement them or the framework falls back (with a warning) to plain
 * `render` — meaning the SSR HTML is regenerated on the client.
 */
export interface PageRenderer<
  TPageType extends string = string,
  TAppContext = unknown,
> {
  render(targetEl: HTMLElement, ctx: RenderContext<TPageType, TAppContext>): void;
  destroy(): void;

  renderSSR?(targetEl: HTMLElement, ctx: RenderContext<TPageType, TAppContext>): void;

  hydrate?(targetEl: HTMLElement, ctx: RenderContext<TPageType, TAppContext>): void;

  activateSubpage?(subpage: SubpageActivation<TPageType>): void;

  applyPageStyles?(styles: Record<string, string | number>): void;
  applyComponentStyles?(componentId: string, styles: Record<string, string | number>): void;
}

export type PageRendererFactory<
  TPageType extends string = string,
  TAppContext = unknown,
> = () => PageRenderer<TPageType, TAppContext>;
