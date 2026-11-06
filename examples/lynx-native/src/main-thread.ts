/**
 * The card's main thread: mount the first page, and show what each link or
 * form answers. A real host would post each `NavigateRequest` to the
 * background thread, fetch there, and resolve with the JSON that comes back;
 * this card answers from the in-bundle stand-in after a short delay, so
 * overlapping taps behave as they would on a slow network.
 *
 * Built with `AIRO_LYNX_COLLECTOR` set (the device script's collector),
 * every mount, navigation and touch also sends a device report.
 */

import { reportOnTouch, sendDeviceReport } from '@airo-js/lynx/device';
import { type LynxErrorInfo, mountLynx } from '@airo-js/lynx/runtime';

import { cartridge, template } from './cartridge.js';
import { renderPage } from './server.js';

// The engine calls processData on the main thread; vanilla cards install the identity.
Object.assign(globalThis, { processData: (data: unknown): unknown => data });

const errors: string[] = [];
const record = (info: LynxErrorInfo): void => {
  errors.push(`${info.phase}${info.member ? ` ${info.member}` : ''}: ${info.error.message}`);
};

const report = (label: string): void => {
  if (!AIRO_LYNX_COLLECTOR) return;
  const info = typeof SystemInfo === 'undefined' ? undefined : SystemInfo;
  setTimeout(() => sendDeviceReport(lynx, label, { errors: [...errors], nav: mount?.nav ?? null }, info), 400);
};

let mount: ReturnType<typeof mountLynx> | null = null;
let navigations = 0;

lynx.getEngine().addEventListener('__RenderPage', () => {
  if (mount) return;
  mount = mountLynx({
    cartridge,
    config: {},
    template,
    page: renderPage({ url: AIRO_LYNX_START, method: 'get', fields: {} }),
    colorScheme: 'light',
    baseUrl: AIRO_LYNX_ASSETS,
    onError: record,
    // Lynx Explorer has no native picker to show, so this card takes the
    // next enabled option. An app opens its action sheet here and resolves
    // with the value the person picked.
    onPick: (request) => {
      // No photo library either: a file is an object of the host's own, here a url it could upload from.
      if (request.kind === 'file') return [{ name: 'photo.png', type: 'image/png', uri: `${AIRO_LYNX_ASSETS}photo.png` }];
      const enabled = request.options.filter((o) => !o.disabled);
      const next = enabled[(enabled.findIndex((o) => o.value === request.value) + 1) % enabled.length];
      report(`picked-${next?.value}`);
      return next?.value;
    },
    // An app posts this to the background thread and runs it there; this card answers in-bundle.
    fetch: async (url) => {
      const body = url === '/api/stock' ? { left: 3 } : { error: 'not found' };
      const status = url === '/api/stock' ? 200 : 404;
      return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
    },
    onNavigate: (request) =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(renderPage(request));
          report(`navigated-${++navigations}`);
        }, 150);
      }),
  });
  report('mounted');
  if (AIRO_LYNX_COLLECTOR) {
    reportOnTouch(lynx, () => ({ errors: [...errors], nav: mount?.nav ?? null }), typeof SystemInfo === 'undefined' ? undefined : SystemInfo);
  }
});
