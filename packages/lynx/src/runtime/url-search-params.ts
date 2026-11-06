/**
 * `URLSearchParams` for hydrate code, where the main thread has none.
 *
 * Page code reads its own query with it (`new URLSearchParams(location.search)`),
 * and it is plain string work, not a host capability, so the mount supplies
 * it, as it does `setInterval` and `FormData`. It follows the URL Standard's
 * `application/x-www-form-urlencoded` parser and serializer: `+` reads as a
 * space and is written for one, and only `*-._`, digits and letters go
 * unescaped.
 */

type Init = string | Iterable<readonly [string, string]> | Record<string, string> | undefined | null;

function decode(text: string): string {
  const spaced = text.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    // A stray `%` is kept as written, as the URL Standard's percent-decode does.
    return spaced.replace(/%([0-9a-f]{2})/gi, (m, hex: string) => {
      try {
        return decodeURIComponent(`%${hex}`);
      } catch {
        return m;
      }
    });
  }
}

const encode = (text: string): string =>
  encodeURIComponent(text)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export class MountURLSearchParams {
  #list: [string, string][] = [];

  constructor(init?: Init) {
    if (init === undefined || init === null) return;
    if (typeof init === 'string') {
      for (const part of (init.startsWith('?') ? init.slice(1) : init).split('&')) {
        if (!part) continue;
        const at = part.indexOf('=');
        this.#list.push(at < 0 ? [decode(part), ''] : [decode(part.slice(0, at)), decode(part.slice(at + 1))]);
      }
      return;
    }
    if (typeof (init as Iterable<unknown>)[Symbol.iterator] === 'function') {
      for (const pair of init as Iterable<readonly [string, string]>) {
        if (pair.length !== 2) throw new TypeError("URLSearchParams: each pair needs a name and a value");
        this.#list.push([String(pair[0]), String(pair[1])]);
      }
      return;
    }
    for (const [name, value] of Object.entries(init)) this.#list.push([name, String(value)]);
  }

  get size(): number {
    return this.#list.length;
  }

  append(name: string, value: string): void {
    this.#list.push([String(name), String(value)]);
  }

  delete(name: string, value?: string): void {
    this.#list = this.#list.filter(([n, v]) => n !== name || (value !== undefined && v !== String(value)));
  }

  get(name: string): string | null {
    return this.#list.find(([n]) => n === name)?.[1] ?? null;
  }

  getAll(name: string): string[] {
    return this.#list.filter(([n]) => n === name).map(([, v]) => v);
  }

  has(name: string, value?: string): boolean {
    return this.#list.some(([n, v]) => n === name && (value === undefined || v === String(value)));
  }

  /** Replaces the first pair named `name` and removes the rest, as the standard does. */
  set(name: string, value: string): void {
    const at = this.#list.findIndex(([n]) => n === name);
    if (at < 0) {
      this.#list.push([String(name), String(value)]);
      return;
    }
    this.#list[at] = [String(name), String(value)];
    this.#list = this.#list.filter(([n], i) => i <= at || n !== name);
  }

  /** Stable sort by name, by UTF-16 code units, as the standard specifies. */
  sort(): void {
    this.#list = this.#list
      .map((pair, i) => [pair, i] as const)
      .sort(([a, i], [b, j]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : i - j))
      .map(([pair]) => pair);
  }

  forEach(fn: (value: string, name: string, params: MountURLSearchParams) => void): void {
    for (const [n, v] of [...this.#list]) fn(v, n, this);
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [n, v] of this.#list) yield [n, v];
  }

  *keys(): IterableIterator<string> {
    for (const [n] of this.#list) yield n;
  }

  *values(): IterableIterator<string> {
    for (const [, v] of this.#list) yield v;
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  toString(): string {
    return this.#list.map(([n, v]) => `${encode(n)}=${encode(v)}`).join('&');
  }
}
