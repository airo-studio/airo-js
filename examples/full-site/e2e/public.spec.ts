/**
 * The public site in a real browser — the first time this example's
 * hydrate path has ever run anywhere but in a test environment.
 *
 * Until 0.11.0 `server.ts` referenced `/client.js` and never served it, so
 * every earlier claim about hydration rested on unit tests alone. These
 * checks are the ones an HTTP smoke cannot make: the bundle loads and
 * executes, the mount adopts the server's DOM without replacing a node,
 * and the listener `hydrate()` attaches actually fires.
 */

import { expect, test } from '@playwright/test';

import { collectProblems, observeAppMutations, ssrNodeAdopted } from './helpers.js';

test('the client bundle is served as JavaScript', async ({ request }) => {
  const res = await request.get('/client.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('javascript');
  expect((await res.text()).length).toBeGreaterThan(1000);
});

test('the index hydrates in place: no node replaced, listener attached, console clean', async ({ page }) => {
  await observeAppMutations(page);
  const problems = collectProblems(page);

  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  // `client.ts` stamps the mode it mounted in once `mountCartridge` resolves.
  await expect(page.locator('html')).toHaveAttribute('data-airo-mounted', 'hydrate');

  expect(await ssrNodeAdopted(page)).toBe(true);

  // The home view's `hydrate()` attaches one delegated click listener that
  // records the clicked card's title on the render root. Dispatch the click
  // and read the attribute in the same task, before the link navigates.
  const lastClick = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('a.fs-card__link');
    if (!link) return 'no-link';
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return document.querySelector('[data-last-click]')?.getAttribute('data-last-click') ?? null;
  });
  expect(lastClick).toBe('Why one snapshot');
  expect(problems).toEqual([]);
});

test('a document page hydrates in place too', async ({ page }) => {
  await observeAppMutations(page);
  const problems = collectProblems(page);

  await page.goto('/doc/why-snapshots');
  await expect(page.locator('html')).toHaveAttribute('data-airo-mounted', 'hydrate');
  expect(await ssrNodeAdopted(page)).toBe(true);
  await expect(page.locator('h1.fs-title')).toHaveText('Why one snapshot');
  expect(problems).toEqual([]);
});

test('the 404 page ships no client bundle and throws nothing', async ({ page }) => {
  // The browser reports the document's own 404 status as a resource error;
  // that is the status under test, not a problem.
  const problems = collectProblems(page, (text) => /status of 404/.test(text));
  const res = await page.goto('/does-not-exist');
  expect(res?.status()).toBe(404);
  expect(await page.locator('script[src="/client.js"]').count()).toBe(0);
  expect(problems).toEqual([]);
});
