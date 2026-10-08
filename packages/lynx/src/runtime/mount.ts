/**
 * `mountLynx` — show a cartridge's server-rendered pages as native UI.
 *
 * The device does what a browser does with a server-rendered airo-js page:
 * it receives the page's HTML and the snapshot it was rendered from, builds
 * elements from the HTML, and runs the cartridge's hydrate handlers over
 * them. Templates and the data pipeline stay on the server; the device
 * needs neither. So the host hands it, per page:
 *
 * ```ts
 * { html, snapshot, nav }   // markup inside the mount element, the post-Transformer
 *                           // snapshot, and the navigation state it was rendered for
 * ```
 *
 * and the mount
 *
 *   1. parses `html` (strict tokenizer) and builds Lynx elements plus the
 *      JS node model from it — refusing, before anything is shown, markup
 *      it has no mapping for;
 *   2. mounts the cartridge with `createCartridgeApp` in hydrate mode,
 *      `nav` as the initial navigation state, no router, and the facade
 *      root as the host, so the cartridge's hydrate handlers run unchanged;
 *   3. turns link taps and form submissions into the host's `onNavigate`,
 *      and shows the page it answers with — only the newest request's.
 *
 * The host owns the network (M13): on Lynx that is the background thread,
 * so `onNavigate` typically posts the request there and resolves with the
 * page that comes back as JSON.
 *
 * Gates, routers and `update()` are not part of this mount: auth gates stay
 * on the server and in the host, and every page change is a server render.
 */

import type { App, AppConfig, IEventBus, NavigationState, PageRenderer, PageRendererFactory } from '@airo-js/core';
import { EventBus, resolveMountEntry } from '@airo-js/core';
import { type Cartridge, createCartridgeApp, getDefaultRenderResolver, type Template, templateToAppConfig } from '@airo-js/cartridge-kit';

import { type LynxErrorInfo, log, report } from './errors.js';
import { FacadeHost, installGlobalGuards } from './facade.js';
import type { NavigateRequest } from './navigation.js';
import { fromParsed, insertChildren, LynxElement } from './node-model.js';
import { type ElementRef, getPapi, type NativeListener, type Papi } from './papi.js';
import { tokenize } from './tokenize.js';
import { NativeTree } from './tree.js';

/** One server-rendered page, as the host receives it. */
export interface LynxPage<TData = unknown> {
  /** The markup that goes inside the mount element — what the server writes into its host. */
  html: string;
  /** The post-Transformer snapshot `html` was rendered from. */
  snapshot: TData;
  /** The navigation state the server rendered for; `page` names the page in the template. */
  nav: Partial<NavigationState> & { page: string };
}

export type ColorScheme = 'light' | 'dark';

type AnyFactory = PageRendererFactory<string, unknown>;

export interface MountLynxOptions<TData, TConfig, TPageType extends string = string> {
  cartridge: Cartridge<TData, TConfig>;
  /** The cartridge's editable config, as `mountCartridge` takes it. */
  config: TConfig;
  /** The template whose page graph `nav.page` names. */
  template: Template<TConfig, TPageType>;
  /** The first page, if the host has it already. Otherwise call `show()` when it arrives. */
  page?: LynxPage<TData>;
  /**
   * The phone's appearance. Sets the page's theme class, which is what the
   * normaliser turned `@media (prefers-color-scheme: dark)` into. The host
   * reads the OS setting; there is no media query on device. Default light.
   */
  colorScheme?: ColorScheme;
  /** Where relative `src` values in the markup resolve, e.g. `https://example.com/`. */
  baseUrl?: string;
  /**
   * A link was tapped or a form submitted, and no handler prevented it. Make
   * the request (following redirects) and return the page to show, or
   * nothing to stay. Errors and empty answers leave the page as it is.
   */
  onNavigate?: (request: NavigateRequest) => Promise<LynxPage<TData> | void | undefined> | LynxPage<TData> | void | undefined;
  /** Every render, hydrate, event and navigation error, including refusals. Also logged. */
  onError?: (info: LynxErrorInfo) => void;
  /**
   * Renderer lookup when the views are not all in `cartridge.views` (a
   * native build that registers its own hydrate halves). Default: the
   * cartridge's own views and mailbox.
   */
  resolveRenderer?: (pageType: string) => AnyFactory | undefined;
}

export interface LynxMount {
  /** Show a page the host fetched itself, under the same rules as a navigation result. */
  show(page: LynxPage): void;
  /** Switch the theme class, when the phone's appearance changes. */
  setColorScheme(scheme: ColorScheme): void;
  /** The navigation state of the page on screen, or null before the first. */
  readonly nav: NavigationState | null;
  /** The cartridge app on screen, or null. */
  readonly app: App | null;
  /** Tear down the app, the elements, the listeners and the global guards. */
  destroy(): void;
}

/** What a hydrate call must not leave behind when it throws: its listeners. */
function guardedResolver(
  base: (pageType: string) => AnyFactory | undefined,
  host: FacadeHost,
  onError: MountLynxOptions<unknown, unknown>['onError'],
): (pageType: string) => AnyFactory | undefined {
  return (pageType) => {
    const factory = base(pageType);
    if (!factory) return undefined;
    return () => {
      const inner = factory() as PageRenderer<string, unknown>;
      const renderer: PageRenderer<string, unknown> = {
        render: (target, ctx) => inner.render(target, ctx),
        destroy: () => inner.destroy(),
        hydrate: (target, ctx) => {
          const recording = host.record();
          host.phase = 'hydrate';
          try {
            if (inner.hydrate) inner.hydrate(target, ctx);
            else inner.render(target, ctx);
            host.stopRecording(recording);
          } catch (err) {
            host.rollback(recording);
            report(onError, 'hydrate', err);
          }
        },
      };
      if (inner.activateSubpage) renderer.activateSubpage = (s) => inner.activateSubpage!(s);
      if (inner.applyPageStyles) renderer.applyPageStyles = (s) => inner.applyPageStyles!(s);
      if (inner.applyComponentStyles) renderer.applyComponentStyles = (id, s) => inner.applyComponentStyles!(id, s);
      return renderer;
    };
  };
}

function isPage(value: unknown): value is LynxPage {
  const v = value as LynxPage | null;
  return !!v && typeof v === 'object' && typeof v.html === 'string' && !!v.nav && typeof v.nav.page === 'string';
}

export function mountLynx<TData, TConfig, TPageType extends string = string>(
  opts: MountLynxOptions<TData, TConfig, TPageType>,
): LynxMount {
  const papi: Papi = getPapi();
  const onError = opts.onError;
  const appConfig = templateToAppConfig(opts.template, opts.cartridge.id) as AppConfig<string>;

  const pageRef: ElementRef = papi.createPage('0', 0);
  const pid = papi.uniqueId(pageRef);

  let facadeHost!: FacadeHost;
  const tree = new NativeTree({
    papi,
    pid,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    onControlEvent: (el, event, native) => facadeHost.onControlEvent(el, event, native),
  });

  let destroyed = false;
  let app: App | null = null;
  let host: LynxElement | null = null;
  let nav: NavigationState | null = null;

  // Newest request wins (D12): each navigation takes a number; a result for
  // an older number than the newest is dropped, as a browser drops the load
  // it cancelled when you tapped something else.
  let latest = 0;

  const navigate = (request: NavigateRequest): void => {
    if (!opts.onNavigate) {
      report(onError, 'navigate', new Error(`[@airo-js/lynx] ${request.method.toUpperCase()} ${request.url} was not followed: mountLynx has no onNavigate`));
      return;
    }
    const seq = ++latest;
    const handler = opts.onNavigate;
    Promise.resolve()
      .then(() => handler(request))
      .then(
        (result) => {
          if (destroyed) return;
          if (seq !== latest) {
            log.debug(`[@airo-js/lynx] dropped the answer to ${request.url}: a newer navigation started`, { seq, latest });
            return;
          }
          if (result === undefined || result === null) return;
          if (!isPage(result)) {
            report(onError, 'navigate', new Error(`[@airo-js/lynx] onNavigate for ${request.url} returned something that is not { html, snapshot, nav }`));
            return;
          }
          show(result as LynxPage<TData>);
        },
        (err: unknown) => {
          if (!destroyed && seq === latest) report(onError, 'navigate', err);
        },
      );
  };

  facadeHost = new FacadeHost({ tree, ...(onError ? { reporter: onError } : {}), navigate });
  const uninstallGuards = installGlobalGuards(facadeHost);
  const onTap: NativeListener = (native) => facadeHost.onTap(native);
  papi.addEventListener(pageRef, 'tap', onTap);
  tree.setPageTheme(pageRef, opts.colorScheme ?? 'light');

  const baseResolver = opts.resolveRenderer ?? (getDefaultRenderResolver(opts.cartridge) as (t: string) => AnyFactory | undefined);
  const resolveRenderer = guardedResolver(baseResolver, facadeHost, onError);

  function show(page: LynxPage<TData>): void {
    if (destroyed) return;
    // 1. Parse and check everything before touching the screen: a page that
    //    cannot be built leaves the current one in place.
    const next = new LynxElement('div', false);
    try {
      const nodes = fromParsed(tokenize(page.html));
      tree.validate(nodes);
      insertChildren(next, nodes);
    } catch (err) {
      report(onError, 'render', err);
      return;
    }

    // 2. Take the old page down: its renderer's cleanup, then its elements.
    if (app) {
      app.destroy();
      app = null;
    }
    const previousRef = host?.ref ?? null;
    tree.viewport = next;
    const nextRef = tree.project(next);
    if (!nextRef) return;
    if (previousRef) papi.replace(nextRef, previousRef);
    else papi.append(pageRef, nextRef);
    host = next;
    tree.markDirty();
    tree.flushNow();

    // 3. Hydrate over it — but only with the renderer the markup was made
    //    by. PageManager falls back to the default entry when `nav.page`
    //    is not one; on device that would run one page's handlers over
    //    another page's markup, so a page that does not resolve is shown
    //    without behaviour and reported instead.
    const entry = resolveMountEntry({ pages: appConfig.pages, initialNavState: page.nav });
    if (entry.resolution.fellBack) {
      const { requested, reason } = entry.resolution.fellBack;
      report(onError, 'hydrate', new Error(`[@airo-js/lynx] nav.page "${requested}" does not name an entry page of the template (${reason}); the page is shown without behaviour`));
      nav = null;
      tree.flushNow();
      return;
    }
    const events: IEventBus = new EventBus();
    events.on('renderer:missing', (payload: unknown) => {
      const { pageType } = payload as { pageType: string };
      report(onError, 'hydrate', new Error(`[@airo-js/lynx] no renderer for page type "${pageType}"; the page is shown without behaviour`));
    });
    try {
      app = createCartridgeApp(opts.cartridge, appConfig, page.snapshot, opts.config, {
        host: facadeHost.facade(next) as unknown as HTMLElement,
        hydrate: true,
        enableRouter: false,
        initialNavState: page.nav,
        events,
        resolveRenderer,
      });
      nav = app.getNavigationState();
    } catch (err) {
      report(onError, 'hydrate', err);
    }
    tree.flushNow();
  }

  if (opts.page) show(opts.page);

  return {
    show: (page) => show(page as LynxPage<TData>),
    setColorScheme(scheme) {
      tree.setPageTheme(pageRef, scheme);
    },
    get nav() {
      return nav;
    },
    get app() {
      return app;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      app?.destroy();
      app = null;
      if (host?.ref) papi.remove(pageRef, host.ref);
      host = null;
      papi.removeEventListener(pageRef, 'tap', onTap);
      uninstallGuards();
      tree.markDirty();
      tree.flushNow();
    },
  };
}
