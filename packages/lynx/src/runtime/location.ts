/**
 * `location` and `history` for hydrate code, from the url the host says the
 * page is.
 *
 * There is no address bar on device: the page's url is what the host asked
 * its server for (`LynxPage.url`). Page code reads its own query from it
 * (`?published`, `?relist`) and drops a one-time flag with
 * `history.replaceState`, so the mount keeps that url and answers both from
 * it. Going somewhere else is a navigation like a tapped link: `assign`,
 * `replace`, `reload` and setting `href` go through the host's `onNavigate`
 * (M13: the network is the host's). Neither keeps a back stack, which is the
 * host's: `pushState`, `back` and the rest stay refused by name.
 */

import { resolveUrl } from './tree.js';

export interface LocationDeps {
  /** The url of the page on screen, as the host gave it, or null when it gave none. */
  current(): string | null;
  /** Record a new url for the page on screen (history.replaceState). */
  setCurrent(url: string): void;
  /** What relative page urls resolve against: mountLynx's `baseUrl`. */
  base: string | undefined;
  /** Ask the host for a page, as a tapped link does. */
  navigate(url: string): void;
  refuse(member: string, detail?: string): never;
}

interface Parts {
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
}

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)(.*)$/i;

function parts(url: string): Parts | null {
  const m = ABSOLUTE.exec(url);
  if (!m) return null;
  const [, protocol, host, rest] = m as unknown as [string, string, string, string];
  const hashAt = rest.indexOf('#');
  const beforeHash = hashAt < 0 ? rest : rest.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  return {
    protocol: protocol.toLowerCase(),
    host,
    pathname: (queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt)) || '/',
    search: queryAt < 0 || queryAt === beforeHash.length - 1 ? '' : beforeHash.slice(queryAt),
    hash: hashAt < 0 || hashAt === rest.length - 1 ? '' : rest.slice(hashAt),
  };
}

/** `url` against `against`, keeping the query for a `#fragment`, as a browser does. */
function resolveAgainst(url: string, against: string): string {
  if (url.startsWith('#')) return `${against.split('#')[0]}${url}`;
  return resolveUrl(url, against);
}

export class MountLocation {
  constructor(private readonly deps: LocationDeps) {}

  /** The page's url, absolute. Refused when the host gave none, or a path with no `baseUrl`. */
  #absolute(member: string): string {
    const url = this.deps.current();
    if (url === null) return this.deps.refuse(`location.${member}`, 'the page has no url: give LynxPage a `url`');
    const absolute = this.deps.base ? resolveUrl(url, this.deps.base) : url;
    if (!ABSOLUTE.test(absolute)) return this.deps.refuse(`location.${member}`, `"${url}" is a path: give mountLynx a baseUrl`);
    return absolute;
  }

  #parts(member: string): Parts {
    return parts(this.#absolute(member))!;
  }

  get href(): string {
    return this.#absolute('href');
  }
  set href(url: string) {
    this.assign(url);
  }
  get origin(): string {
    const p = this.#parts('origin');
    return `${p.protocol}//${p.host}`;
  }
  get protocol(): string {
    return this.#parts('protocol').protocol;
  }
  get host(): string {
    return this.#parts('host').host;
  }
  get hostname(): string {
    return this.#parts('hostname').host.replace(/:\d+$/, '');
  }
  get port(): string {
    return /:(\d+)$/.exec(this.#parts('port').host)?.[1] ?? '';
  }
  get pathname(): string {
    return this.#parts('pathname').pathname;
  }
  get search(): string {
    return this.#parts('search').search;
  }
  get hash(): string {
    return this.#parts('hash').hash;
  }

  /** Go to `url`, through the host's `onNavigate`. A `#fragment` alone changes the url and stays. */
  assign(url: string): void {
    const target = String(url);
    if (target.startsWith('#')) {
      this.deps.setCurrent(resolveAgainst(target, this.#absolute('assign')));
      return;
    }
    this.deps.navigate(target);
  }

  /** As `assign`: the device keeps no history for it to replace an entry in. */
  replace(url: string): void {
    this.assign(url);
  }

  /** Ask the host for this page again. */
  reload(): void {
    const url = this.deps.current();
    if (url === null) this.deps.refuse('location.reload', 'the page has no url: give LynxPage a `url`');
    this.deps.navigate(url);
  }

  toString(): string {
    return this.href;
  }
}

export class MountHistory {
  #state: unknown = null;

  constructor(private readonly deps: LocationDeps) {}

  get state(): unknown {
    return this.#state;
  }

  /**
   * Record `state`, and `url` as the page's url, without a request: what a
   * browser does. The host reads the new url from the mount's `url`.
   */
  replaceState(state: unknown, _unused?: string, url?: string | null): void {
    this.#state = state ?? null;
    if (url === undefined || url === null) return;
    const current = this.deps.current();
    if (current === null) this.deps.refuse('history.replaceState', 'the page has no url to replace: give LynxPage a `url`');
    // Resolved like a link on this page; a path stays a path when the page's url is one.
    const absolute = ABSOLUTE.test(current) ? current : `http://page.invalid${current.startsWith('/') ? '' : '/'}${current}`;
    const next = resolveAgainst(String(url), absolute);
    this.deps.setCurrent(ABSOLUTE.test(current) ? next : next.replace(/^http:\/\/page\.invalid/, ''));
  }
}

/** Members hydrate code may use: the rest are refused by name. */
export const LOCATION_SETTABLE: ReadonlySet<string> = new Set(['href']);
export const HISTORY_SETTABLE: ReadonlySet<string> = new Set<string>();
