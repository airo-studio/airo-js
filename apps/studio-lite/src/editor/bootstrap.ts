/**
 * studio-lite browser bootstrap.
 *
 * Lane D slice 1 wired in: load the active cartridge's persisted state
 * from /api/state (falls back to seed when no save exists yet), POST
 * saves to /api/save, and track the latest known revision_id to drop
 * stale responses (the design doc's monotonic-revision invalidation
 * pattern).
 *
 * Cartridge-based page composition (driving the layout via the airo-js
 * view system + presentation cartridges) follows once @airo-js/embed
 * matures. For v0 we mount the elements directly into static HTML.
 */

// Side-effect import — registers all four <studio-*> custom elements.
import '@airo-js/devtools';

import type { Cartridge } from '@airo-js/cartridge-kit';
import { docPageCartridge, sampleDocPageData } from '@airo-js/doc-cartridges';

const cartridge = docPageCartridge as unknown as Cartridge;
const ACTIVE_CARTRIDGE_ID = 'doc-page';

interface MountTarget {
  cartridge: Cartridge;
  data: unknown;
}

interface StateResponse {
  cartridgeId: string;
  revisionId: number;
  data: unknown;
  createdAt: number;
  seeded: boolean;
}

interface SaveResponse {
  cartridgeId: string;
  revisionId: number;
  createdAt: number;
}

let latestRevisionId = 0;

ready(() => {
  void boot();
});

async function boot(): Promise<void> {
  const initial = await loadInitial();
  latestRevisionId = initial.revisionId;

  const editor = document.querySelector('studio-editor') as HTMLElement | null;
  const score = document.querySelector('studio-aio-score') as HTMLElement | null;
  const coverage = document.querySelector('studio-adapter-coverage') as HTMLElement | null;
  const preview = document.querySelector('studio-preview-triple') as HTMLElement | null;

  applyMount(editor, cartridge, initial.data);
  applyMount(score, cartridge, initial.data);
  applyMount(coverage, cartridge, initial.data);
  applyMount(preview, cartridge, initial.data);

  if (initial.seeded) {
    // eslint-disable-next-line no-console
    console.info('[studio-lite] no persisted state yet — using seed (revisionId: 0)');
  } else {
    // eslint-disable-next-line no-console
    console.info(`[studio-lite] loaded revision ${initial.revisionId}`);
  }

  if (editor) {
    editor.addEventListener('studio-editor-data-change', (e) => {
      const next = (e as CustomEvent<{ data: unknown }>).detail.data;
      if (score) (score as unknown as MountTarget).data = next;
      if (coverage) (coverage as unknown as MountTarget).data = next;
      if (preview) (preview as unknown as MountTarget).data = next;
    });
    editor.addEventListener('studio-editor-save', (e) => {
      const detail = (e as CustomEvent<{ data: unknown }>).detail;
      void persistAndTrack(detail.data);
    });
    editor.addEventListener('studio-editor-validation-error', (e) => {
      const detail = (e as CustomEvent<{ error: Error }>).detail;
      // eslint-disable-next-line no-console
      console.warn('[studio-lite] validation error:', detail.error);
    });
  }
}

async function loadInitial(): Promise<{ data: unknown; revisionId: number; seeded: boolean }> {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Partial<StateResponse>;
    if (typeof body.revisionId === 'number' && body.data !== undefined) {
      return {
        data: body.data,
        revisionId: body.revisionId,
        seeded: body.seeded ?? body.revisionId === 0,
      };
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[studio-lite] /api/state failed; using imported sample', e);
  }
  return { data: sampleDocPageData, revisionId: 0, seeded: true };
}

async function persistAndTrack(data: unknown): Promise<void> {
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cartridgeId: ACTIVE_CARTRIDGE_ID, data }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const body = (await res.json()) as Partial<SaveResponse>;
    if (typeof body.revisionId !== 'number') {
      throw new Error('save response missing revisionId');
    }
    // Revision-id pattern: drop stale responses (in case fast saves overlap
    // and an older save's response arrives after a newer one).
    if (body.revisionId <= latestRevisionId) {
      // eslint-disable-next-line no-console
      console.info(
        `[studio-lite] dropping stale save response ${body.revisionId} (latest: ${latestRevisionId})`,
      );
      return;
    }
    latestRevisionId = body.revisionId;
    // eslint-disable-next-line no-console
    console.info(`[studio-lite] saved revision ${body.revisionId}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[studio-lite] /api/save failed', e);
  }
}

function applyMount(el: HTMLElement | null, c: Cartridge, data: unknown): void {
  if (!el) return;
  const target = el as unknown as MountTarget;
  target.cartridge = c;
  target.data = data;
}

function ready(fn: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn);
  } else {
    fn();
  }
}
