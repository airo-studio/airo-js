/**
 * The stand-in for a server. A real host fetches `{ html, snapshot, nav }`
 * from its own server on the background thread; this card renders the same
 * shape in-bundle so it runs with no backend. Templates write through
 * `escapeHtml`, as server templates do — that is the input contract the
 * on-device tokenizer is built for.
 */

import { escapeHtml as esc } from '@airo-js/core';
import type { LynxPage, NavigateRequest } from '@airo-js/lynx/runtime';

export interface Note {
  slug: string;
  title: string;
  summary: string;
  body: string[];
}

export interface NotesData {
  notes: Note[];
  /** Set on the search page. */
  query?: string;
  /** Set after subscribing. */
  list?: string;
  /** The controls page with `?open=1`: its details open and its sheet shown, for a check that cannot tap. */
  open?: boolean;
}

const NOTES: Note[] = [
  {
    slug: 'one-snapshot',
    title: 'Why one snapshot',
    summary: 'A rendered page, a JSON-LD block and an agent answer that disagree are three bugs wearing one coat.',
    body: [
      'Most sites derive their title three times. Each derivation is a chance to disagree.',
      'Derive once, render many: the page, the feed and the agent read the same snapshot.',
    ],
  },
  {
    slug: 'silent-failures',
    title: 'The failures that do not fail',
    summary: 'The expensive bugs are the ones where the wrong behaviour looks right in isolation.',
    body: ['A fallback that hides a missing value is a bug report nobody files.'],
  },
  {
    slug: 'one-renderer',
    title: 'One renderer per page',
    summary: 'A page type gets one renderer. Layout families that share a chunk ship each other’s weight to every visitor.',
    body: [
      'Split by the page a visitor lands on, not by the components a designer grouped together.',
      'The cost of a shared chunk is paid on every page that did not need half of it.',
    ],
  },
];

const icon = (path: string, cls = 'icon'): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

const frame = (inner: string): string => `<div class="app">${inner}</div>`;

function home(data: NotesData): string {
  const cards = data.notes
    .map(
      (n) =>
        `<li class="card"><a class="card__link" href="/notes/${esc(n.slug)}">${esc(n.title)}</a><p class="card__summary">${esc(n.summary)}</p></li>`,
    )
    .join('');
  return frame(
    [
      '<header class="bar"><h1>Field notes</h1>',
      `<button class="counter" type="button" data-action="count">${icon('M12 5v14M5 12h14')}Tapped <span class="counter__n">0</span></button></header>`,
      '<p class="lede">Short notes on building things that outlast their authors.</p>',
      `<ul class="cards">${cards}</ul>`,
      '<section class="panel">',
      `<button class="panel__toggle" type="button" aria-expanded="false" data-action="toggle">${icon('m6 9 6 6 6-6', 'icon chevron')}More about these notes</button>`,
      '<div class="panel__body" hidden><p>They are written slowly and revised often. Tap again to hide this.</p></div>',
      '</section>',
      '<form class="search" action="/search" method="get" role="search">',
      '<input class="search__input" type="search" name="q" placeholder="Search the notes" autocomplete="off">',
      `<button class="btn btn--primary" type="submit">${icon('m21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14')}Search</button>`,
      '</form>',
      '<p class="echo">You typed: <span class="echo__value">nothing yet</span></p>',
      '<form class="subscribe" action="/subscribe" method="post"><input type="hidden" name="list" value="weekly">',
      '<button class="btn" type="submit">Subscribe weekly</button></form>',
      '<figure class="art"><div class="art__frame"></div><figcaption>An aspect-ratio box with no width of its own.</figcaption></figure>',
      `<a class="back" href="/controls">Controls${icon('m9 18 6-6-6-6')}</a>`,
    ].join(''),
  );
}

function note(n: Note): string {
  return frame(
    [
      `<a class="back" href="/">${icon('m15 18-6-6 6-6')}All notes</a>`,
      `<article class="note"><h1>${esc(n.title)}</h1><p class="lede">${esc(n.summary)}</p>`,
      ...n.body.map((p) => `<p>${esc(p)}</p>`),
      '</article>',
    ].join(''),
  );
}

function search(data: NotesData): string {
  const q = data.query ?? '';
  const hits = data.notes.filter((n) => `${n.title} ${n.summary}`.toLowerCase().includes(q.toLowerCase()));
  return frame(
    [
      `<a class="back" href="/">${icon('m15 18-6-6 6-6')}All notes</a>`,
      `<h1>Results for &#8220;${esc(q)}&#8221;</h1>`,
      hits.length
        ? `<ul class="cards">${hits.map((n) => `<li class="card"><a class="card__link" href="/notes/${esc(n.slug)}">${esc(n.title)}</a></li>`).join('')}</ul>`
        : '<p class="lede">Nothing matches.</p>',
    ].join(''),
  );
}

/**
 * The elements a browser gives behaviour of its own, and the things a device
 * does not size or match by itself: a logo sized by its height only, a toast
 * hidden by `:empty`, switches drawn by `:checked + …`, and a photo in a grid
 * whose height comes from its width and `aspect-ratio`. Its behaviour also
 * uses what the mount provides: `window.setInterval`, a file input answered
 * by the host's `onPick`, the host's `fetch`, and `FormData`.
 */
function controls(data: NotesData): string {
  return frame(
    [
      `<a class="back" href="/">${icon('m15 18-6-6 6-6')}All notes</a>`,
      '<h1>Controls</h1>',
      '<div class="logos"><img class="logo" src="logo.svg" width="360" height="136" alt="Field notes, an SVG">',
      '<img class="logo" src="logo.png" width="360" height="136" alt="Field notes, a PNG"></div>',
      `<details class="faq"${data.open ? ' open' : ''}><summary class="faq__q">${icon('m6 9 6 6 6-6', 'icon chevron')}What is a field note?</summary>`,
      '<p class="faq__a">A short note, written slowly and revised often.</p></details>',
      '<form class="sort" action="/search" method="get"><label class="field">Sort by <select class="sort__select" name="sort">',
      '<option value="new">Newest</option><option value="old" selected>Oldest</option>',
      '<optgroup label="Other"><option value="az">A to Z</option><option value="za" disabled>Z to A</option></optgroup>',
      '</select></label></form>',
      '<p class="picked">Sorted by <span class="picked__value">old</span></p>',
      '<label class="switch"><span>Mail me</span><input class="sr-only" type="checkbox" name="mail" checked><span class="switch__track"></span></label>',
      '<label class="switch"><span>Weekly digest</span><input class="sr-only" type="checkbox" name="digest" data-digest><span class="switch__track"></span></label>',
      '<div class="seg"><label><input class="sr-only" type="radio" name="theme" value="light" checked><span class="seg__pill">Light</span></label>',
      '<label><input class="sr-only" type="radio" name="theme" value="dark"><span class="seg__pill">Dark</span></label></div>',
      '<p class="ticker">Ticks: <span class="ticker__n" data-ticks>0</span></p>',
      '<form class="profile" data-profile><input class="profile__city" name="city" value="Lisboa">',
      '<label class="pick"><span>Choose a photo</span><input class="sr-only" type="file" name="photo" accept="image/*"></label>',
      '<span class="picked-file" data-file>No photo</span></form>',
      '<p class="stock">Stock: <span class="stock__n" data-stock>unknown</span></p>',
      '<div class="item"><div class="item__gallery"><figure class="gallery"><img class="gallery__img" src="photo.png" width="1024" height="768" alt="A field"></figure></div>',
      '<p class="item__after">The photo is as tall as its width and ratio make it; this line follows it.</p></div>',
      '<div class="row"><button class="btn" type="button" data-action="sheet">Open the sheet</button>',
      '<button class="btn" type="button" data-action="toast">Show a toast</button></div>',
      '<dialog class="sheet" id="sheet" aria-labelledby="sheet-title"><h2 class="sheet__title" id="sheet-title">A bottom sheet</h2>',
      '<p>Tap outside it, or the button, to close it.</p><button class="btn" type="button" data-close>Close</button></dialog>',
      '<p class="toast" data-toast></p>',
      '<nav class="tabbar"><a class="tabbar__link" href="/">Home</a><a class="tabbar__link" href="/controls">Controls</a></nav>',
    ].join(''),
  );
}

/**
 * Layouts a browser draws and the device has to be told about: a link that
 * is a block (a card: photo box, then body), an SVG cover filling a square
 * box, a grid that centres its one child, a photo under the common base
 * rule `img { max-width: 100%; height: auto }`, and preformatted text.
 */
function layout(): string {
  return frame(
    [
      `<a class="back" href="/">${icon('m15 18-6-6 6-6')}All notes</a>`,
      '<h1>Layout</h1>',
      '<p class="where">Query <span data-q>none</span>, address after <span data-href>unchanged</span></p>',
      '<pre class="code" data-probe="pre">mountLynx({\n  fetch,\n})</pre>',
      '<div class="listings"><a class="listing" href="/notes/one-snapshot" data-probe="card">',
      '<div class="listing__media" data-probe="media"><img class="listing__img" src="logo.svg" alt="" data-probe="cover"></div>',
      '<div class="listing__body" data-probe="body"><p class="listing__title">Why one snapshot</p><p class="listing__price">€53,76</p></div>',
      `<span class="listing__go" data-probe="go">${icon('m9 18 6-6-6-6')}</span></a>`,
      '<a class="listing" href="/notes/one-snapshot" data-probe="card2">',
      '<img class="listing__cover" src="logo.svg" alt="" data-probe="cover2">',
      '<div class="listing__body" data-probe="body2"><p class="listing__title">Ratio on the image</p></div></a></div>',
      '<div class="based"><figure class="based__gallery" data-probe="gallery"><img class="based__img" src="photo.png" width="1024" height="768" alt="A field" data-probe="photo"></figure>',
      '<p class="based__after" data-probe="after">This line follows the photo.</p></div>',
    ].join(''),
  );
}

function subscribed(data: NotesData): string {
  return frame(
    `<a class="back" href="/">${icon('m15 18-6-6 6-6')}All notes</a><h1>Subscribed</h1><p class="lede">You are on the ${esc(data.list ?? '')} list.</p>`,
  );
}

const field = (fields: NavigateRequest['fields'], name: string): string => {
  const v = fields[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

/** What the server would answer for a request. */
export function renderPage(req: Pick<NavigateRequest, 'url' | 'method' | 'fields'>): LynxPage<NotesData> {
  // The url a page is, which page code reads through `location`.
  return { ...answer(req), url: req.url };
}

function answer(req: Pick<NavigateRequest, 'url' | 'method' | 'fields'>): LynxPage<NotesData> {
  const [path = '/', query = ''] = req.url.split('?');
  const data: NotesData = { notes: NOTES };
  if (path === '/controls') {
    data.open = /(^|&)open=1(&|$)/.test(query);
    return { html: controls(data), snapshot: data, nav: { page: 'controls' } };
  }
  if (path === '/layout') return { html: layout(), snapshot: data, nav: { page: 'layout' } };
  if (path === '/search') {
    data.query = field(req.fields, 'q');
    return { html: search(data), snapshot: data, nav: { page: 'search' } };
  }
  if (path === '/subscribe' && req.method === 'post') {
    data.list = field(req.fields, 'list');
    return { html: subscribed(data), snapshot: data, nav: { page: 'done' } };
  }
  const slug = /^\/notes\/([\w-]+)$/.exec(path)?.[1];
  const found = slug ? NOTES.find((n) => n.slug === slug) : undefined;
  if (found) return { html: note(found), snapshot: data, nav: { page: 'note', slug: found.slug } };
  return { html: home(data), snapshot: data, nav: { page: 'home' } };
}
