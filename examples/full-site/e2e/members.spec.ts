/**
 * The members area in a real browser.
 *
 * The smoke proves the HTTP contract; these prove the two things only a
 * browser can: the gate PAINTS (the 401 shell is empty markup until the
 * client runs), and a server-rendered private page hydrates in place with
 * exactly the requests the design promises — one `/api/members/me`, no
 * `/auth/session`.
 */

import { expect, test, type Page } from '@playwright/test';

import { collectProblems, collectRequests, observeAppMutations, ssrNodeAdopted } from './helpers.js';

/** The visitor is on the gate's panel; click through the demo provider. */
async function signInThroughProvider(page: Page, password = 'demo'): Promise<void> {
  await page.locator('a.fs-signin__button').click();
  await expect(page).toHaveURL(/\/oauth\/authorize\?/);
  await page.locator('#p').fill(password);
  await page.locator('button[type=submit]').click();
}

test('anonymous /members: the gate paints the panel, blocks, and the API is never asked', async ({ page }) => {
  const problems = collectProblems(page, (text) => /status of 401/.test(text));
  const requests = collectRequests(page);

  const res = await page.goto('/members');
  expect(res?.status()).toBe(401);
  await expect(page.locator('html')).toHaveAttribute('data-airo-mounted', 'csr');
  await expect(page.locator('html')).toHaveAttribute('data-airo-blocked', 'login');
  await expect(page.locator('.fs-signin')).toBeVisible();
  await expect(page.locator('a.fs-signin__button')).toHaveAttribute('href', '/auth/login?next=%2Fmembers');

  expect(requests).toContain('/auth/session');
  expect(requests).not.toContain('/api/members/me');
  expect(problems).toEqual([]);
});

test('sign in: the dashboard is server-rendered, hydrates in place, and asks the API once', async ({ page }) => {
  await observeAppMutations(page);
  await page.goto('/members');
  await expect(page.locator('.fs-signin')).toBeVisible();

  await signInThroughProvider(page);
  await expect(page).toHaveURL(/\/members$/);
  await expect(page.locator('h1.fs-title')).toHaveText('Hello, Demo Member');
  const requests = collectRequests(page);
  const problems = collectProblems(page);

  // Reload with the session: this is the server-rendered private page.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-airo-mounted', 'hydrate');
  await expect(page.locator('html')).toHaveAttribute('data-airo-blocked', '');
  expect(await ssrNodeAdopted(page)).toBe(true);
  expect(requests.filter((p) => p === '/api/members/me')).toHaveLength(1);
  expect(requests).not.toContain('/auth/session');
  expect(problems).toEqual([]);

  // A note opens; its page is private too.
  await page.locator('a.fs-card__link', { hasText: 'What ships next' }).click();
  await expect(page).toHaveURL(/\/note\/roadmap$/);
  await expect(page.locator('h1.fs-title')).toHaveText('What ships next');

  // Sign out is a plain form; afterwards the gate is back.
  await page.goto('/members');
  await page.locator('.fs-signout button').click();
  await expect(page).toHaveURL(/\/$/);
  const res = await page.goto('/members');
  expect(res?.status()).toBe(401);
  await expect(page.locator('.fs-signin')).toBeVisible();
});

test('deep link: a note url survives the round trip', async ({ page }) => {
  await page.goto('/note/roadmap');
  await expect(page.locator('a.fs-signin__button')).toHaveAttribute('href', '/auth/login?next=%2Fnote%2Froadmap');
  await signInThroughProvider(page);
  await expect(page).toHaveURL(/\/note\/roadmap$/);
  await expect(page.locator('h1.fs-title')).toHaveText('What ships next');
});

test('wrong password stays at the provider with an error; cancel returns to the gate, still anonymous', async ({ page }) => {
  await page.goto('/members');
  await signInThroughProvider(page, 'nope');
  await expect(page).toHaveURL(/\/oauth\/authorize$/);
  await expect(page.locator('.idp .err')).toContainText('Wrong username or password');

  await page.locator('a.cancel').click();
  await expect(page).toHaveURL(/\/members$/);
  await expect(page.locator('.fs-signin')).toBeVisible();
});

test('an external next is replaced by the home page', async ({ page }) => {
  await page.goto('/auth/login?next=https://evil.example/phish');
  await expect(page).toHaveURL(/\/oauth\/authorize\?/);
  await page.locator('#p').fill('demo');
  await page.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/localhost:\d+\/$/);
});
