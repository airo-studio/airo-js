/**
 * Shared Playwright helpers: the in-place-hydration proof and a console
 * collector. Used by the public and the members specs.
 */

import type { Page } from '@playwright/test';

declare global {
  interface Window {
    /** The `.fs-page` element the HTML parser created — the server's node. */
    __ssrRoot?: Element;
    /** Replacements of `#app`'s direct children AFTER parsing ended (i.e. by the client). */
    __postParseAppMutations: number;
  }
}

/**
 * Two facts that together prove hydration adopted the server's DOM: the
 * element the parser created is still attached inside `#app` after the
 * mount, and the client made no child replacements on `#app` once parsing
 * had ended. (Counting from document start would also count the parser's
 * own insertions — the JSON-LD script, a text node, the page div.)
 */
export async function observeAppMutations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__postParseAppMutations = 0;
    window.__ssrRoot = undefined;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!window.__ssrRoot && node instanceof Element && node.classList.contains('fs-page')) {
            window.__ssrRoot = node;
          }
        }
        // Module scripts run after the parser finishes, so anything the
        // client does to #app happens while readyState is no longer 'loading'.
        if ((record.target as Element).id === 'app' && document.readyState !== 'loading') {
          window.__postParseAppMutations += record.addedNodes.length + record.removedNodes.length;
        }
      }
    });
    // Init scripts run before any element exists; `document` is the one
    // Node that does, and a subtree observer on it sees `#app` from the
    // moment the parser creates it.
    observer.observe(document, { childList: true, subtree: true });
  });
}

/** True when the parser's page element survived the mount, inside `#app`. */
export async function ssrNodeAdopted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const node = window.__ssrRoot;
    return !!node && document.contains(node) && node.closest('#app') !== null && window.__postParseAppMutations === 0;
  });
}

export function collectProblems(page: Page, ignore: (text: string) => boolean = () => false): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${String(err)}`));
  page.on('console', (msg) => {
    if ((msg.type() === 'error' || msg.type() === 'warning') && !ignore(msg.text())) {
      problems.push(`${msg.type()}: ${msg.text()}`);
    }
  });
  return problems;
}

/** Every same-origin request path the page makes from now on. */
export function collectRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname === 'localhost') paths.push(url.pathname);
  });
  return paths;
}
