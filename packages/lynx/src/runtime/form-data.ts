/**
 * `FormData` for hydrate code on device, where the main thread has none.
 *
 * `new FormData(form)` takes a form's entries by the same HTML rules a
 * submission uses (`formEntries`): named, enabled controls, checked boxes,
 * a select's selected option, a file input's files as the host's objects.
 * The rest is the standard surface over that list. A host's `fetch` that
 * receives one as a `body` reads its `entries()`.
 */

import { formEntries } from './navigation.js';
import type { LynxElement } from './node-model.js';

type Entry = [string, unknown];

/** The value a browser would store: a string, or an object (a file) as it is. */
const stored = (value: unknown): unknown => (typeof value === 'object' && value !== null ? value : String(value));

/**
 * A `FormData` class whose constructor reads a facade form. `unwrap` turns
 * the object hydrate code holds into the model element behind it.
 */
export function formDataClass(unwrap: (value: unknown) => LynxElement | null, refuse: (member: string, detail?: string) => never) {
  return class FormData {
    readonly #entries: Entry[];

    constructor(form?: unknown, submitter?: unknown) {
      if (form === undefined) {
        this.#entries = [];
        return;
      }
      const el = unwrap(form);
      if (el?.tag !== 'form') refuse('new FormData(…)', 'pass the <form> element, or nothing');
      this.#entries = formEntries(el, submitter === undefined ? null : unwrap(submitter));
    }

    append(name: string, value: unknown): void {
      this.#entries.push([String(name), stored(value)]);
    }
    delete(name: string): void {
      for (let i = this.#entries.length - 1; i >= 0; i--) if (this.#entries[i]![0] === name) this.#entries.splice(i, 1);
    }
    get(name: string): unknown {
      return this.#entries.find(([n]) => n === name)?.[1] ?? null;
    }
    getAll(name: string): unknown[] {
      return this.#entries.filter(([n]) => n === name).map(([, v]) => v);
    }
    has(name: string): boolean {
      return this.#entries.some(([n]) => n === name);
    }
    set(name: string, value: unknown): void {
      const at = this.#entries.findIndex(([n]) => n === name);
      this.delete(name);
      this.#entries.splice(at === -1 ? this.#entries.length : at, 0, [String(name), stored(value)]);
    }
    *entries(): IterableIterator<Entry> {
      for (const [n, v] of this.#entries) yield [n, v];
    }
    *keys(): IterableIterator<string> {
      for (const [n] of this.#entries) yield n;
    }
    *values(): IterableIterator<unknown> {
      for (const [, v] of this.#entries) yield v;
    }
    forEach(fn: (value: unknown, name: string, data: FormData) => void): void {
      for (const [n, v] of this.#entries) fn(v, n, this);
    }
    [Symbol.iterator](): IterableIterator<Entry> {
      return this.entries();
    }
  };
}
