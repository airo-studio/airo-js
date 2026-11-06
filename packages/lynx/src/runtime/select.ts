/**
 * `<select>` on device.
 *
 * Lynx has no picker element, and the framework draws no UI of its own. So a
 * select is shown as a closed browser select shows it, the selected option's
 * label, and a tap asks the host for the choice: `onPick` receives the
 * options and resolves with the value picked. The picker itself (an action
 * sheet, a wheel) is the host's UI. The answer lands as a browser's does: the
 * selection changes, then `input` and `change` fire on the select.
 *
 * Selectedness follows HTML's rules for a single-choice select (display
 * size 1): the last option marked `selected`, else the first enabled option;
 * once the selection has been set, by a pick or by `select.value = x` with no
 * option of that value, having none selected means none. `multiple` and
 * `size` above 1 (a list box, not a picker) are refused by name in the tree
 * pass.
 *
 * Nothing in this file calls Element PAPI.
 */

import { descendants, type LynxElement, textContent } from './node-model.js';

/** One choice, as the host's picker shows it. */
export interface PickOption {
  value: string;
  label: string;
  disabled: boolean;
  /** The `label` of the `<optgroup>` it sits in. */
  group?: string;
}

/** What a tapped `<select>` asks the host's `onPick` for. Answer with the value picked. */
export interface SelectPickRequest {
  kind: 'select';
  /** The select's `name`, or `''`. */
  name: string;
  /** The value selected now, or null when no option is. */
  value: string | null;
  options: PickOption[];
}

/**
 * What a tapped `<input type="file">` (or its label) asks the host's
 * `onPick` for. Answer with the files picked: objects of the host's own (a
 * photo-library item, a path), which hydrate code reads from `input.files`
 * and hands back to the host, through the host's `fetch` or a form's
 * `FormData`. The framework never reads them.
 */
export interface FilePickRequest {
  kind: 'file';
  /** The input's `name`, or `''`. */
  name: string;
  /** The `accept` attribute as written (`image/*`, `.pdf`), or `''`. */
  accept: string;
  multiple: boolean;
}

/** What a tapped control asks the host's `onPick` for. */
export type PickRequest = SelectPickRequest | FilePickRequest;

/** What `onPick` answers: a value for a select, the files for a file input, or nothing to leave it. */
export type PickAnswer = string | readonly unknown[] | null | undefined;

const strip = (s: string): string => s.replace(/[\t\n\f\r ]+/g, ' ').trim();

/** The select's list of options, in tree order: its own, and those in its optgroups. */
export function optionsOf(select: LynxElement): LynxElement[] {
  return [...descendants(select)].filter((o) => o.tag === 'option' && (o.parent === select || o.parent?.parent === select));
}

/** The select an option belongs to, or null. */
export function selectOf(option: LynxElement): LynxElement | null {
  const parent = option.parent;
  if (parent?.tag === 'select') return parent;
  return parent?.tag === 'optgroup' && parent.parent?.tag === 'select' ? parent.parent : null;
}

/** `option.value`: the `value` attribute, else the option's text. */
export function optionValue(option: LynxElement): string {
  return option.attrs.get('value') ?? optionText(option);
}

/** `option.text`: its text, whitespace collapsed. */
export function optionText(option: LynxElement): string {
  return strip(textContent(option));
}

/** `option.label`: a non-empty `label` attribute, else the option's text. */
export function optionLabel(option: LynxElement): string {
  return option.attrs.get('label') || optionText(option);
}

export function isDisabledOption(option: LynxElement): boolean {
  return option.attrs.has('disabled') || (option.parent?.tag === 'optgroup' && option.parent.attrs.has('disabled'));
}

/** The option a single-choice select has selected, or null. */
export function selectedOption(select: LynxElement): LynxElement | null {
  const options = optionsOf(select);
  for (let i = options.length - 1; i >= 0; i--) if (options[i]!.selected) return options[i]!;
  if (select.valueDirty) return null;
  return options.find((o) => !isDisabledOption(o)) ?? null;
}

/** Select `option` (null: none) and nothing else. */
export function selectOption(select: LynxElement, option: LynxElement | null): void {
  for (const o of optionsOf(select)) o.selected = o === option;
  select.valueDirty = true;
}

export function pickRequest(select: LynxElement): SelectPickRequest {
  const selected = selectedOption(select);
  return {
    kind: 'select',
    name: select.attrs.get('name') ?? '',
    value: selected ? optionValue(selected) : null,
    options: optionsOf(select).map((o) => {
      const group = o.parent?.tag === 'optgroup' ? o.parent.attrs.get('label') : undefined;
      return {
        value: optionValue(o),
        label: optionLabel(o),
        disabled: isDisabledOption(o),
        ...(group !== undefined ? { group } : {}),
      };
    }),
  };
}
