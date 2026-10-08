/**
 * The Lynx globals this card uses. On Lynx they are identifiers each
 * thread's wrapper provides, not properties of `globalThis`.
 */
declare const lynx: {
  getEngine(): { addEventListener(type: '__RenderPage', fn: () => void): void };
  getJSContext(): { dispatchEvent(e: { type: string; data: string }): void };
  getCoreContext(): { addEventListener(type: string, fn: (e: { data?: unknown }) => void): void };
};
declare const SystemInfo: { platform?: string; lynxSdkVersion?: string } | undefined;
declare function setTimeout(fn: () => void, ms: number): number;

/** Where device reports go during a device check; empty otherwise. Set at build time. */
declare const AIRO_LYNX_COLLECTOR: string;
/** The url of the first page the card shows (`AIRO_LYNX_START`, default `/`). Set at build time. */
declare const AIRO_LYNX_START: string;
/** Where the pages' images resolve: the device check's server, or the dev server. Set at build time. */
declare const AIRO_LYNX_ASSETS: string;
