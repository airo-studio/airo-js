/**
 * Schema-driven form rendering. Plain functions returning Lit
 * TemplateResult — composed by <studio-editor> into the editor pane.
 *
 * The dispatcher walks a JSON Schema fragment and a parallel runtime value,
 * emitting one field per leaf. Updates bubble up via a single FieldChangeHandler
 * keyed by JSON path. The owning component holds the form state and re-renders.
 *
 * Slice 2 coverage:
 *   - string (with format=date-time → date input)
 *   - number / integer
 *   - boolean
 *   - array of primitives (string/number/integer/boolean)
 *   - object with declared properties (recursive)
 *   - $ref, oneOf/anyOf, arrays of objects, free-form objects → raw-JSON fallback
 *
 * Anything outside that set falls back to a JSON textarea — the cartridge
 * stays editable; we don't half-render a complex shape.
 */

import { html, nothing, type TemplateResult } from 'lit';

// ───────────────────────────── Types ────────────────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type JsonPath = ReadonlyArray<string | number>;

export type FieldChangeHandler = (path: JsonPath, value: JsonValue | undefined) => void;

/** Loose JSON Schema shape — only the fields we read. */
export interface SchemaFragment {
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, SchemaFragment>;
  required?: string[];
  items?: SchemaFragment;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  $ref?: string;
}

interface FieldArgs<T> {
  schema: SchemaFragment;
  value: T | undefined;
  onChange: FieldChangeHandler;
  path: JsonPath;
  label: string;
  required: boolean;
}

// ───────────────────────────── Dispatcher ──────────────────────────

export function renderSchemaForm(
  schema: SchemaFragment,
  value: JsonValue | undefined,
  onChange: FieldChangeHandler,
  path: JsonPath = [],
  fieldName?: string,
  required = false,
): TemplateResult {
  const label = schema.title ?? fieldName ?? '(value)';

  if (schema.$ref) {
    return renderFallbackField({
      schema,
      value,
      onChange,
      path,
      label,
      required,
      hint: 'Schema $ref — raw JSON edit',
    });
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case 'string':
      if (schema.format === 'date-time') {
        return renderDateField({ schema, value: value as string | undefined, onChange, path, label, required });
      }
      return renderTextField({ schema, value: value as string | undefined, onChange, path, label, required });

    case 'number':
    case 'integer':
      return renderNumberField({ schema, value: value as number | undefined, onChange, path, label, required });

    case 'boolean':
      return renderBooleanField({ schema, value: value as boolean | undefined, onChange, path, label, required });

    case 'array': {
      const items = schema.items;
      const itemType = Array.isArray(items?.type) ? items?.type[0] : items?.type;
      if (items && (itemType === 'string' || itemType === 'number' || itemType === 'integer' || itemType === 'boolean')) {
        return renderPrimitiveArrayField({
          schema,
          value: value as JsonValue[] | undefined,
          onChange,
          path,
          label,
          required,
        });
      }
      return renderFallbackField({
        schema,
        value,
        onChange,
        path,
        label,
        required,
        hint: 'Array of complex items — raw JSON edit',
      });
    }

    case 'object':
      if (schema.properties) {
        return renderObjectField({
          schema,
          value: value as Record<string, JsonValue> | undefined,
          onChange,
          path,
          label,
          required,
        });
      }
      return renderFallbackField({
        schema,
        value,
        onChange,
        path,
        label,
        required,
        hint: 'Free-form object — raw JSON edit',
      });

    default:
      return renderFallbackField({
        schema,
        value,
        onChange,
        path,
        label,
        required,
        hint: 'Unsupported schema — raw JSON edit',
      });
  }
}

// ───────────────────────────── Field helpers ────────────────────────

function fieldHeader(label: string, required: boolean, description: string | undefined): TemplateResult {
  return html`
    <label class="schema-field__label">
      ${label}${required ? html`<span class="schema-field__required" aria-label="required">*</span>` : nothing}
    </label>
    ${description ? html`<p class="schema-field__description">${description}</p>` : nothing}
  `;
}

function renderTextField({ schema, value, onChange, path, label, required }: FieldArgs<string>): TemplateResult {
  return html`
    <div class="schema-field schema-field--text">
      ${fieldHeader(label, required, schema.description)}
      <input
        class="schema-field__input"
        type="text"
        .value=${value ?? ''}
        @input=${(e: Event) => onChange(path, (e.target as HTMLInputElement).value)}
      />
    </div>
  `;
}

function renderDateField({ schema, value, onChange, path, label, required }: FieldArgs<string>): TemplateResult {
  // Trim ISO 8601 down to YYYY-MM-DD for native date input. Round-trip back to ISO on change.
  const dateOnly = value ? value.slice(0, 10) : '';
  return html`
    <div class="schema-field schema-field--date">
      ${fieldHeader(label, required, schema.description)}
      <input
        class="schema-field__input"
        type="date"
        .value=${dateOnly}
        @input=${(e: Event) => {
          const next = (e.target as HTMLInputElement).value;
          if (!next) {
            onChange(path, undefined);
            return;
          }
          onChange(path, new Date(`${next}T00:00:00.000Z`).toISOString());
        }}
      />
    </div>
  `;
}

function renderNumberField({ schema, value, onChange, path, label, required }: FieldArgs<number>): TemplateResult {
  const isInt = (Array.isArray(schema.type) ? schema.type[0] : schema.type) === 'integer';
  return html`
    <div class="schema-field schema-field--number">
      ${fieldHeader(label, required, schema.description)}
      <input
        class="schema-field__input"
        type="number"
        step=${isInt ? '1' : 'any'}
        .value=${value === undefined ? '' : String(value)}
        @input=${(e: Event) => {
          const raw = (e.target as HTMLInputElement).value;
          if (raw === '') {
            onChange(path, undefined);
            return;
          }
          const n = isInt ? parseInt(raw, 10) : parseFloat(raw);
          onChange(path, Number.isNaN(n) ? undefined : n);
        }}
      />
    </div>
  `;
}

function renderBooleanField({ schema, value, onChange, path, label, required }: FieldArgs<boolean>): TemplateResult {
  return html`
    <div class="schema-field schema-field--boolean">
      <label class="schema-field__label schema-field__label--inline">
        <input
          class="schema-field__checkbox"
          type="checkbox"
          .checked=${value === true}
          @change=${(e: Event) => onChange(path, (e.target as HTMLInputElement).checked)}
        />
        <span>${label}${required ? html`<span class="schema-field__required" aria-label="required">*</span>` : nothing}</span>
      </label>
      ${schema.description ? html`<p class="schema-field__description">${schema.description}</p>` : nothing}
    </div>
  `;
}

function renderPrimitiveArrayField({
  schema,
  value,
  onChange,
  path,
  label,
  required,
}: FieldArgs<JsonValue[]>): TemplateResult {
  const items = (value ?? []) as JsonValue[];
  const itemSchema: SchemaFragment = schema.items ?? { type: 'string' };
  const itemType = Array.isArray(itemSchema.type) ? itemSchema.type[0] : itemSchema.type;

  function setItem(i: number, next: JsonValue | undefined): void {
    const arr = [...items];
    if (next === undefined) {
      arr.splice(i, 1);
    } else {
      arr[i] = next;
    }
    onChange(path, arr);
  }
  function appendItem(): void {
    const blank: JsonValue = itemType === 'number' || itemType === 'integer' ? 0 : itemType === 'boolean' ? false : '';
    onChange(path, [...items, blank]);
  }

  return html`
    <div class="schema-field schema-field--array">
      ${fieldHeader(label, required, schema.description)}
      <ol class="schema-field__list">
        ${items.map(
          (it, i) => html`
            <li class="schema-field__list-item">
              ${renderSchemaForm(itemSchema, it, (_p, next) => setItem(i, next), [...path, i], `${label}[${i}]`)}
              <button
                type="button"
                class="schema-field__remove"
                aria-label="Remove item ${i + 1}"
                @click=${() => setItem(i, undefined)}
              >
                ✕
              </button>
            </li>
          `,
        )}
      </ol>
      <button type="button" class="schema-field__add" @click=${appendItem}>+ Add ${label.replace(/s$/, '')}</button>
    </div>
  `;
}

function renderObjectField({
  schema,
  value,
  onChange,
  path,
  label,
  required,
}: FieldArgs<Record<string, JsonValue>>): TemplateResult {
  const props = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);
  const obj = value ?? {};

  return html`
    <fieldset class="schema-field schema-field--object">
      <legend class="schema-field__legend">
        ${label}${required ? html`<span class="schema-field__required" aria-label="required">*</span>` : nothing}
      </legend>
      ${schema.description ? html`<p class="schema-field__description">${schema.description}</p>` : nothing}
      ${Object.entries(props).map(([propName, propSchema]) =>
        renderSchemaForm(
          propSchema,
          obj[propName],
          onChange,
          [...path, propName],
          propName,
          requiredSet.has(propName),
        ),
      )}
    </fieldset>
  `;
}

function renderFallbackField({
  schema,
  value,
  onChange,
  path,
  label,
  required,
  hint,
}: FieldArgs<JsonValue> & { hint: string }): TemplateResult {
  // Pretty-print existing value; on commit, parse + dispatch. On parse failure
  // we hold the raw text in a data attribute so the user keeps editing without
  // losing input — but we don't dispatch the change until it parses.
  const serialized = value === undefined ? '' : safeStringify(value);
  return html`
    <div class="schema-field schema-field--fallback">
      ${fieldHeader(label, required, schema.description)}
      <p class="schema-field__hint">${hint}</p>
      <textarea
        class="schema-field__textarea"
        rows="6"
        .value=${serialized}
        @change=${(e: Event) => {
          const raw = (e.target as HTMLTextAreaElement).value;
          if (raw.trim() === '') {
            onChange(path, undefined);
            return;
          }
          try {
            onChange(path, JSON.parse(raw));
          } catch {
            // Invalid JSON — surface error via custom event for the editor shell to catch.
            (e.target as HTMLTextAreaElement).dispatchEvent(
              new CustomEvent('schema-field-parse-error', {
                bubbles: true,
                composed: true,
                detail: { path, raw },
              }),
            );
          }
        }}
      ></textarea>
    </div>
  `;
}

function safeStringify(v: JsonValue): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}

// ───────────────────────────── Path-keyed update ────────────────────

/**
 * Immutable set-by-path. Returns a new copy of `root` with `value` written
 * at `path`. Builds intermediate objects/arrays as needed; setting
 * `undefined` deletes the leaf.
 */
export function setIn(root: JsonValue | undefined, path: JsonPath, value: JsonValue | undefined): JsonValue | undefined {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (head === undefined) return value;

  if (typeof head === 'number') {
    const arr = Array.isArray(root) ? [...root] : [];
    const updated = setIn(arr[head], rest, value);
    if (updated === undefined && rest.length === 0) {
      arr.splice(head, 1);
    } else {
      arr[head] = (updated ?? null) as JsonValue;
    }
    return arr;
  }

  const obj: Record<string, JsonValue> =
    root && typeof root === 'object' && !Array.isArray(root) ? { ...root } : {};
  const updated = setIn(obj[head], rest, value);
  if (updated === undefined && rest.length === 0) {
    delete obj[head];
  } else if (updated !== undefined) {
    obj[head] = updated;
  }
  return obj;
}
