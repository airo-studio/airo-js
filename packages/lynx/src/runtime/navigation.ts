/**
 * Links and forms on device: what a tapped `<a href>` or a submitted
 * `<form>` asks the host for.
 *
 * Inside a Lynx card there is no browser to follow a link or post a form,
 * so the runtime turns each into one `NavigateRequest` and hands it to the
 * host's `onNavigate`. The host makes the request — its network, its auth,
 * its redirects (M13) — and answers with the next page, or nothing.
 *
 * Form fields follow the HTML form-submission rules for the controls the
 * device has: a control counts when it has a name and is not disabled
 * (itself or through a disabled fieldset); text inputs and textareas give
 * their current value, hidden inputs their markup value, a select its
 * selected option's value (nothing when none is, or it is disabled), the
 * submitter button its own name and value; a repeated name keeps every
 * value, in tree order.
 */

import { descendants, type LynxElement } from './node-model.js';
import { isDisabledOption, optionValue, selectedOption } from './select.js';

export interface NavigateRequest {
  /** The `href` or form `action` as written in the markup; the host resolves it. */
  url: string;
  method: 'get' | 'post';
  /**
   * Submitted fields; a name given more than once maps to a list. Empty for a
   * link. For `get`, a browser replaces the action's query with these — the
   * host does the same.
   */
  fields: Record<string, string | string[]>;
  /** What started it. */
  source: 'link' | 'form';
}

/** The request a tapped link makes, or null for one that stays on the page. */
export function linkRequest(a: LynxElement): NavigateRequest | null {
  const href = a.attrs.get('href');
  if (href === undefined || href === '' || href.startsWith('#') || /^javascript:/i.test(href)) return null;
  return { url: href, method: 'get', fields: {}, source: 'link' };
}

const isDisabled = (el: LynxElement, form: LynxElement): boolean => {
  if (el.attrs.has('disabled')) return true;
  for (let a = el.parent; a && a !== form; a = a.parent) {
    if (a.tag === 'fieldset' && a.attrs.has('disabled')) return true;
  }
  return false;
};

/** Does tapping this button submit its form? */
export function isSubmitButton(el: LynxElement): boolean {
  return el.tag === 'button' && (el.attrs.get('type') ?? 'submit').toLowerCase() === 'submit';
}

/** A submit button's form: its nearest `<form>` ancestor. */
export function formOf(el: LynxElement): LynxElement | null {
  for (let a = el.parent; a; a = a.parent) if (a.tag === 'form') return a;
  return null;
}

/** The request a submitted form makes, by the HTML rules. Null for `method="dialog"`. */
export function formRequest(form: LynxElement, submitter: LynxElement | null): NavigateRequest | null {
  const method = (submitter?.attrs.get('formmethod') ?? form.attrs.get('method') ?? 'get').toLowerCase();
  if (method === 'dialog') return null;
  const url = submitter?.attrs.get('formaction') ?? form.attrs.get('action') ?? '';
  const entries: [string, string][] = [];
  for (const el of descendants(form)) {
    const name = el.attrs.get('name');
    if (!name || isDisabled(el, form)) continue;
    if (el.tag === 'input') {
      entries.push([name, el.value]);
    } else if (el.tag === 'textarea') {
      entries.push([name, el.value]);
    } else if (el.tag === 'select') {
      const option = selectedOption(el);
      if (option && !isDisabledOption(option)) entries.push([name, optionValue(option)]);
    } else if (el.tag === 'button' && el === submitter) {
      entries.push([name, el.attrs.get('value') ?? '']);
    }
  }
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of entries) {
    const prior = fields[name];
    fields[name] = prior === undefined ? value : Array.isArray(prior) ? [...prior, value] : [prior, value];
  }
  return { url, method: method === 'post' ? 'post' : 'get', fields, source: 'form' };
}

/**
 * The button an Enter in a text field presses: the form's first submit
 * button in tree order. Null when it has none (then a form with one text
 * field submits directly, as browsers do).
 */
export function defaultButton(form: LynxElement): LynxElement | null {
  for (const el of descendants(form)) if (isSubmitButton(el)) return el;
  return null;
}

/** How many fields in `form` block implicit submission (text-like inputs). */
export function blockingFields(form: LynxElement): number {
  let n = 0;
  for (const el of descendants(form)) if (el.tag === 'input' && el.as === 'input') n++;
  return n;
}
