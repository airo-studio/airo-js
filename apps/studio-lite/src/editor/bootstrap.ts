/**
 * studio-lite browser bootstrap (slice 1 of studio-lite-editor.md reset).
 *
 * What this does:
 *   - Fetches /api/state, populates the compose drawer (title, description,
 *     metadata details, body markdown).
 *   - Renders the stage from the server's `renderedBodyHtml` plus typed
 *     metadata. No client-side markdown parsing — the bundle stays small;
 *     parsing is consistent with what the publish pipeline produces.
 *   - Debounced save on every input (300ms — design spec). Save returns
 *     a new revision_id; we drop responses with revisionId <= latestKnown
 *     so out-of-order arrivals don't roll state back.
 *   - Coverage strip + Publish-pill update from /api/save and /api/state
 *     responses.
 *   - Publish: POST /api/publish, opens published page in new tab.
 *
 * Deferred to subsequent slices:
 *   - Multi-page pages list (slice 2)
 *   - Click-to-edit on preview (slice 3)
 *   - Audience nav swap (slice 4)
 *   - Authoring-side write-MCP (slice 5)
 */

import type { AdapterCoverageRow } from './adapter-coverage.js';

const SAVE_DEBOUNCE_MS = 300;

interface StudioPageData {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt: string;
  author?: string;
  ogImage?: string;
  tags?: string[];
  body: string;
}

interface StateResponse {
  cartridgeId: string;
  revisionId: number;
  page: StudioPageData;
  renderedBodyHtml: string;
  coverage: AdapterCoverageRow[];
  createdAt: number;
  seeded: boolean;
}

interface SaveResponse {
  cartridgeId: string;
  revisionId: number;
  createdAt: number;
  page: StudioPageData;
  renderedBodyHtml: string;
  coverage: AdapterCoverageRow[];
}

interface PublishResponse {
  ok: boolean;
  pages?: Array<{ slug: string; title: string; canonical: string }>;
  files?: Array<{ path: string; bytes: number }>;
  warnings?: Array<{ code: string; message: string }>;
  outputDir?: string;
  elapsedMs?: number;
  error?: string;
}

// ───────────────────────────── DOM refs ──────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const fields = {
  title: $<HTMLInputElement>('f-title'),
  description: $<HTMLTextAreaElement>('f-description'),
  slug: $<HTMLInputElement>('f-slug'),
  author: $<HTMLInputElement>('f-author'),
  ogImage: $<HTMLInputElement>('f-ogimage'),
  tags: $<HTMLInputElement>('f-tags'),
  body: $<HTMLTextAreaElement>('f-body'),
};

const refs = {
  composeCrumb: $('compose-crumb'),
  bodyCount: $('body-count'),
  coverageStrip: $('coverage-strip'),
  pagesList: $('pages-list'),
  pagesCount: $('pages-count'),
  preview: $('preview'),
  previewMeta: $('preview-meta'),
  previewTitle: $('preview-title'),
  previewLede: $('preview-lede'),
  previewAuthor: $('preview-author'),
  previewToc: $('preview-toc'),
  previewBody: $('preview-body'),
  savedPill: $('saved-pill'),
  publishBtn: $<HTMLButtonElement>('publish-btn'),
  publishTag: $('publish-tag'),
  statusSaved: $('status-saved'),
  statusRevision: $('status-revision'),
  statusPages: $('status-pages'),
};

// ───────────────────────────── state ─────────────────────────────────

let currentPage: StudioPageData | null = null;
let latestRevisionId = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight = false;
let saveCounter = 0;

// ───────────────────────────── boot ──────────────────────────────────

ready(() => {
  void boot();
});

async function boot(): Promise<void> {
  try {
    const initial = await fetchState();
    apply(initial.page, initial.renderedBodyHtml, initial.coverage, initial.revisionId, initial.seeded);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[studio-lite] /api/state failed', e);
    refs.savedPill.textContent = 'Offline';
    return;
  }

  for (const [, el] of Object.entries(fields)) {
    el.addEventListener('input', onComposeInput);
  }

  refs.publishBtn.addEventListener('click', () => {
    void runPublish();
  });
}

async function fetchState(): Promise<StateResponse> {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as StateResponse;
}

// ───────────────────────────── apply state to UI ─────────────────────

function apply(
  page: StudioPageData,
  renderedBodyHtml: string,
  coverage: AdapterCoverageRow[],
  revisionId: number,
  seeded: boolean,
): void {
  currentPage = page;
  latestRevisionId = revisionId;

  // Compose drawer
  fields.title.value = page.title;
  fields.description.value = page.description;
  fields.slug.value = page.slug;
  fields.author.value = page.author ?? '';
  fields.ogImage.value = page.ogImage ?? '';
  fields.tags.value = (page.tags ?? []).join(', ');
  fields.body.value = page.body;
  refs.composeCrumb.textContent = page.slug;
  updateBodyCount(page.body);

  // Stage
  renderStage(page, renderedBodyHtml);

  // Pages list (slice 1: just the active page)
  renderPagesList(page, coverage);

  // Coverage strip
  renderCoverage(coverage);

  // Topbar saved-pill + status bar
  refs.savedPill.classList.remove('saving');
  refs.savedPill.textContent = seeded ? 'Seed · unsaved' : 'Saved';
  refs.statusSaved.textContent = seeded ? '○ Seed' : '● Saved';
  refs.statusRevision.textContent = `SQLite · revision ${revisionId}`;
  refs.statusPages.textContent = '1 page';
  refs.pagesCount.textContent = '1';

  // Publish pill: count of incomplete adapter surfaces
  updatePublishTag(coverage);
}

function renderStage(page: StudioPageData, renderedBodyHtml: string): void {
  refs.previewTitle.textContent = page.title;
  refs.previewLede.textContent = page.description;
  refs.previewAuthor.textContent = page.author ? `By ${page.author}` : '';
  refs.previewMeta.innerHTML = '';
  const isPublished = page.publishedAt && page.publishedAt < page.updatedAt;
  const tag = document.createElement('span');
  tag.className = isPublished ? 'pub-tag' : 'draft-tag';
  tag.textContent = isPublished ? 'PUBLISHED' : 'DRAFT';
  refs.previewMeta.append(
    tag,
    span(`updated ${formatDate(page.updatedAt)}`),
  );
  refs.previewBody.innerHTML = renderedBodyHtml;
  renderToc(renderedBodyHtml);
}

function renderToc(renderedBodyHtml: string): void {
  // Walk the rendered HTML for h2/h3 headings, build TOC anchors that match
  // markdown-it-anchor's auto-id rules (already applied server-side).
  const tmp = document.createElement('div');
  tmp.innerHTML = renderedBodyHtml;
  const headings = Array.from(tmp.querySelectorAll('h2, h3')) as HTMLElement[];
  if (headings.length === 0) {
    refs.previewToc.style.display = 'none';
    return;
  }
  refs.previewToc.style.display = '';
  refs.previewToc.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'toc-label';
  label.textContent = 'On this page';
  refs.previewToc.append(label);
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent ?? '';
    if (h.tagName === 'H3') a.classList.add('sub');
    refs.previewToc.append(a);
  }
}

function renderPagesList(page: StudioPageData, coverage: AdapterCoverageRow[]): void {
  refs.pagesList.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'page active';
  const ready = coverage.filter((r) => r.status === 'ready').length;
  const score = Math.round((ready / Math.max(coverage.length, 1)) * 100);
  const scoreClass = score >= 85 ? 'high' : score >= 70 ? 'mid' : 'low';
  const isPublished = false; // slice 2 wires real publish status per page
  btn.innerHTML = `
    <div>
      <div class="name"></div>
      <div class="row2">
        <span class="status-dot ${isPublished ? 'published' : 'draft'}"></span>
        <span class="type">DocPage</span>
        <span>· now</span>
      </div>
    </div>
    <div class="score ${scoreClass}">${score}</div>
  `;
  const nameEl = btn.querySelector('.name');
  if (nameEl) nameEl.textContent = page.title;
  refs.pagesList.append(btn);
}

function renderCoverage(coverage: AdapterCoverageRow[]): void {
  refs.coverageStrip.innerHTML = '';
  if (coverage.length === 0) {
    const span = document.createElement('span');
    span.className = 'item';
    span.textContent = 'no adapters';
    refs.coverageStrip.append(span);
    return;
  }
  for (const row of coverage) {
    const el = document.createElement('span');
    const ok = row.status === 'ready';
    el.className = `item ${ok ? 'ok' : 'miss'}`;
    el.textContent = `${ok ? '●' : '○'} ${row.displayName}`;
    el.title = ok
      ? `Ready (${row.populatedRequires}/${row.totalRequires} fields)`
      : `${row.missingAlways.length > 0 ? `Missing: ${row.missingAlways.join(', ')}` : 'Validation failing'}`;
    refs.coverageStrip.append(el);
  }
}

function updatePublishTag(coverage: AdapterCoverageRow[]): void {
  const incomplete = coverage.filter((r) => r.status !== 'ready').length;
  refs.publishTag.textContent = incomplete === 0 ? 'ready' : `${incomplete} ${incomplete === 1 ? 'field' : 'fields'}`;
  refs.publishTag.classList.toggle('warn', incomplete > 0);
}

function updateBodyCount(body: string): void {
  const lines = body.split('\n').length;
  const headings = (body.match(/^##+\s/gm) ?? []).length;
  refs.bodyCount.textContent = `${lines} lines · ${headings} headings`;
}

// ─────────────────────────── compose → save ──────────────────────────

function onComposeInput(): void {
  if (!currentPage) return;
  // Build the next page snapshot from the form.
  const next: StudioPageData = {
    ...currentPage,
    title: fields.title.value,
    description: fields.description.value,
    slug: fields.slug.value || currentPage.slug,
    author: fields.author.value || undefined,
    ogImage: fields.ogImage.value || undefined,
    tags: fields.tags.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    body: fields.body.value,
  };
  if (next.tags && next.tags.length === 0) delete next.tags;
  currentPage = next;

  updateBodyCount(next.body);
  refs.savedPill.classList.add('saving');
  refs.savedPill.textContent = 'Saving…';

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void debouncedSave();
  }, SAVE_DEBOUNCE_MS);
}

async function debouncedSave(): Promise<void> {
  if (!currentPage) return;
  // Don't pile saves on top of each other; let the in-flight one finish.
  if (saveInFlight) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void debouncedSave(), 50);
    return;
  }
  saveInFlight = true;
  const id = ++saveCounter;
  const snapshot = currentPage;
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const body = (await res.json()) as SaveResponse;
    // Drop stale responses (revision-id pattern).
    if (body.revisionId <= latestRevisionId) {
      // eslint-disable-next-line no-console
      console.info(`[studio-lite] dropping stale save response ${body.revisionId} (latest ${latestRevisionId})`);
      return;
    }
    latestRevisionId = body.revisionId;
    // Refresh stage + coverage + publish tag from the server's authoritative response.
    refs.previewBody.innerHTML = body.renderedBodyHtml;
    renderToc(body.renderedBodyHtml);
    refs.previewTitle.textContent = body.page.title;
    refs.previewLede.textContent = body.page.description;
    refs.previewAuthor.textContent = body.page.author ? `By ${body.page.author}` : '';
    renderCoverage(body.coverage);
    renderPagesList(body.page, body.coverage);
    updatePublishTag(body.coverage);
    refs.savedPill.classList.remove('saving');
    refs.savedPill.textContent = 'Saved';
    refs.statusSaved.textContent = '● Saved';
    refs.statusRevision.textContent = `SQLite · revision ${body.revisionId}`;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[studio-lite] /api/save failed', e);
    refs.savedPill.classList.remove('saving');
    refs.savedPill.textContent = 'Save failed';
  } finally {
    saveInFlight = false;
    // If user kept typing, the next debounced save will pick up.
    // The id variable is local; keeping it for symmetry/debug.
    void id;
  }
}

// ─────────────────────────── publish ─────────────────────────────────

async function runPublish(): Promise<void> {
  refs.publishBtn.disabled = true;
  const originalTagText = refs.publishTag.textContent;
  refs.publishTag.textContent = '…';
  try {
    const res = await fetch('/api/publish', { method: 'POST' });
    const body = (await res.json()) as PublishResponse;
    if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    const firstPage = body.pages?.[0];
    if (firstPage) {
      window.open(`/publish/${firstPage.slug}/`, '_blank', 'noopener,noreferrer');
    }
    refs.publishTag.textContent = 'live';
    setTimeout(() => {
      refs.publishTag.textContent = originalTagText ?? 'ready';
    }, 1800);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[studio-lite] /api/publish failed', e);
    refs.publishTag.textContent = 'failed';
    setTimeout(() => {
      refs.publishTag.textContent = originalTagText ?? 'ready';
    }, 2200);
  } finally {
    refs.publishBtn.disabled = false;
  }
}

// ─────────────────────────── helpers ─────────────────────────────────

function span(text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

function ready(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}
