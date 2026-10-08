/**
 * @airo-js/lynx/device — the bundle half of the manual device check
 * (`scripts/device-check.mjs`). Not for production bundles: import it only
 * in a card built for a device run.
 *
 * The main thread walks the Lynx element tree and reads back what the engine
 * did with it — tags, classes, a few computed styles, layout boxes — then
 * hands the JSON to the background thread, which posts it to the collector
 * the device script runs. On iOS that is the only channel that reaches the
 * machine: `console.log` goes to the DevTool socket, not to stdout.
 */

export const REPORT_EVENT = 'airo-lynx-device-report';

/** Read through `__GetComputedStyleByKey`, which answers only a few keys on device. */
const STYLE_KEYS = ['color', 'background-color', 'width', 'height', 'opacity'] as const;

export interface DeviceRow {
  tag: string;
  classes: string;
  text?: string;
  style: Partial<Record<(typeof STYLE_KEYS)[number], string>>;
  rect?: unknown;
}

export interface DeviceReport {
  label: string;
  platform: string;
  sdk: string | null;
  at: number;
  elements: DeviceRow[];
  extra: Record<string, unknown>;
}

type Ref = object;
type G = Record<string, ((...args: never[]) => unknown) | undefined>;

/**
 * The card's own `lynx` object. On Lynx it is an identifier the thread's
 * wrapper provides, not a property of `globalThis`, so the card passes it in.
 */
export interface MainThreadLynx {
  getJSContext(): { dispatchEvent(e: { type: string; data: string }): void };
}

export interface BackgroundLynx {
  getCoreContext(): { addEventListener(type: string, fn: (e: { data?: unknown }) => void): void };
}

/** `SystemInfo`, when the card has it. */
export interface SystemInfoLike {
  platform?: string;
  lynxSdkVersion?: string;
}

const g = globalThis as unknown as G;
const call = <T>(name: string, ...args: unknown[]): T | undefined => {
  const fn = g[name] as ((...a: unknown[]) => T) | undefined;
  return typeof fn === 'function' ? fn(...args) : undefined;
};

/**
 * Main thread: walk the page, read layout boxes, and send one report to the
 * background thread. `extra` carries whatever the card wants on record
 * (errors seen by `onError`, the navigation state).
 */
export function sendDeviceReport(
  lynx: MainThreadLynx,
  label: string,
  extra: Record<string, unknown> = {},
  systemInfo?: SystemInfoLike,
): void {
  if (typeof lynx?.getJSContext !== 'function') {
    throw new Error('[@airo-js/lynx/device] sendDeviceReport needs the main thread\'s `lynx` object');
  }
  const page = call<Ref>('__GetPageElement');
  const rows: DeviceRow[] = [];
  const refs: Ref[] = [];
  const visit = (el: Ref): void => {
    const tag = call<string>('__GetTag', el) ?? '?';
    if (tag === 'raw-text') return;
    const row: DeviceRow = { tag, classes: (call<string[]>('__GetClasses', el) ?? []).join(' '), style: {} };
    for (const key of STYLE_KEYS) {
      try {
        const v = call<unknown>('__GetComputedStyleByKey', el, key);
        if (v !== undefined && v !== '') row.style[key] = String(v);
      } catch {
        // Not every engine answers every key.
      }
    }
    const children = call<Ref[]>('__GetChildren', el) ?? [];
    if (tag === 'text' || tag === 'inline-text') {
      const raw = children.find((c) => call<string>('__GetTag', c) === 'raw-text');
      const text = raw ? call<unknown>('__GetAttributeByName', raw, 'text') : undefined;
      if (typeof text === 'string') row.text = text.slice(0, 60);
    }
    rows.push(row);
    refs.push(el);
    for (const child of children) visit(child);
  };
  if (page) visit(page);

  let pending = refs.length;
  let sent = false;
  const send = (): void => {
    if (sent) return;
    sent = true;
    const report: DeviceReport = {
      label,
      platform: systemInfo?.platform ?? 'unknown',
      sdk: systemInfo?.lynxSdkVersion ?? null,
      at: Date.now(),
      elements: rows,
      extra,
    };
    const data = JSON.stringify(report);
    console.log(`AIRO-LYNX-REPORT ${label} ${rows.length} elements`);
    lynx.getJSContext().dispatchEvent({ type: REPORT_EVENT, data });
  };
  // Layout boxes come back through a callback; send once every element answered, or after 2s.
  refs.forEach((el, i) => {
    try {
      call('__InvokeUIMethod', el, 'boundingClientRect', {}, (res: { data?: unknown }) => {
        rows[i]!.rect = res?.data ?? res;
        if (--pending === 0) send();
      });
    } catch {
      if (--pending === 0) send();
    }
  });
  if (pending === 0) send();
  const timer = g.setTimeout as unknown as ((fn: () => void, ms: number) => void) | undefined;
  timer?.(send, 2000);
}

/**
 * Main thread: send a report after every touch on the page, so a person
 * tapping through the card during `device-check.mjs --watch` leaves a record
 * of what each tap did. Listens for `touchend`, not `tap`: the mount owns
 * the page's `tap` listener, and a different event name cannot collide with
 * it. The report goes out after `delayMs`, once the tap has been handled and
 * flushed. Returns how to stop.
 */
export function reportOnTouch(
  lynx: MainThreadLynx,
  extra: () => Record<string, unknown> = () => ({}),
  systemInfo?: SystemInfoLike,
  delayMs = 400,
): () => void {
  const page = call<Ref>('__GetPageElement');
  const add = g.__AddEventListener;
  const remove = g.__RemoveEventListener;
  if (!page || typeof add !== 'function') {
    throw new Error('[@airo-js/lynx/device] reportOnTouch needs the page element and __AddEventListener');
  }
  const timer = g.setTimeout as unknown as (fn: () => void, ms: number) => void;
  let touches = 0;
  const listener = (): void => {
    const n = ++touches;
    timer(() => sendDeviceReport(lynx, `touch-${n}`, extra(), systemInfo), delayMs);
  };
  add(page as never, 'touchend' as never, listener as never, {} as never);
  return () => {
    if (typeof remove === 'function') remove(page as never, 'touchend' as never, listener as never, {} as never);
  };
}

/**
 * Background thread: post every report the main thread sends to
 * `collectorUrl`. The card passes its `lynx` and `fetch`, which the
 * background wrapper provides as identifiers.
 */
export function relayDeviceReports(
  lynx: BackgroundLynx,
  post: (url: string, init: { method: string; body: string; headers: Record<string, string> }) => Promise<unknown>,
  collectorUrl: string,
): void {
  if (typeof lynx?.getCoreContext !== 'function' || typeof post !== 'function') {
    throw new Error('[@airo-js/lynx/device] relayDeviceReports needs the background thread\'s `lynx` and `fetch`');
  }
  lynx.getCoreContext().addEventListener(REPORT_EVENT, (event) => {
    const body = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    const label = (JSON.parse(body) as { label?: string }).label ?? 'report';
    post(`${collectorUrl}?name=${encodeURIComponent(label)}`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    }).then(
      () => console.log(`AIRO-LYNX-REPORT posted ${label}`),
      (err: unknown) => console.log(`AIRO-LYNX-REPORT post failed: ${String(err)}`),
    );
  });
}
