/**
 * studio-lite browser bootstrap.
 *
 * Slice 0 of integration: load the doc-page cartridge + sample fixture,
 * mount the four devtools custom elements with `.cartridge` and `.data`
 * properties, and forward editor data-change events to the score / coverage
 * / preview elements so they recompute on every keystroke.
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

interface MountTarget {
  cartridge: Cartridge;
  data: unknown;
}

ready(() => {
  void boot();
});

async function boot(): Promise<void> {
  const data = await loadData();

  const editor = document.querySelector('studio-editor') as HTMLElement | null;
  const score = document.querySelector('studio-aio-score') as HTMLElement | null;
  const coverage = document.querySelector('studio-adapter-coverage') as HTMLElement | null;
  const preview = document.querySelector('studio-preview-triple') as HTMLElement | null;

  applyMount(editor, cartridge, data);
  applyMount(score, cartridge, data);
  applyMount(coverage, cartridge, data);
  applyMount(preview, cartridge, data);

  if (editor) {
    editor.addEventListener('studio-editor-data-change', (e) => {
      const next = (e as CustomEvent<{ data: unknown }>).detail.data;
      if (score) (score as unknown as MountTarget).data = next;
      if (coverage) (coverage as unknown as MountTarget).data = next;
      if (preview) (preview as unknown as MountTarget).data = next;
    });
    editor.addEventListener('studio-editor-save', (e) => {
      const detail = (e as CustomEvent<{ data: unknown }>).detail;
      // Slice 0: persist to console. Slice 1 wires Lane D's /api/save.
      // eslint-disable-next-line no-console
      console.info('[studio-lite] save (no server persistence yet):', detail.data);
    });
    editor.addEventListener('studio-editor-validation-error', (e) => {
      const detail = (e as CustomEvent<{ error: Error }>).detail;
      // eslint-disable-next-line no-console
      console.warn('[studio-lite] validation error:', detail.error);
    });
  }
}

async function loadData(): Promise<unknown> {
  try {
    const res = await fetch('/api/fixture', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    if (body && typeof body === 'object' && 'data' in body) return body.data;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[studio-lite] /api/fixture failed; using imported sample', e);
  }
  return sampleDocPageData;
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
