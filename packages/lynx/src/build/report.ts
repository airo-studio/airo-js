/**
 * The per-cartridge report: everything in the cartridge's CSS that does not
 * reach the device as written, from two sources.
 *
 *   - **The normaliser** knows what it rewrote, what it emitted (with the
 *     browser behaviour each emitted value reproduces), the selectors the
 *     encoder would reject (taken out of their lists so the rest survive),
 *     the selectors that parse and never match, the `@media` blocks engine
 *     3.9 drops, and the values it could not resolve.
 *   - **The encoder** reports each property it removes as a compilation
 *     warning (`Unsupported property "x" was removed during template
 *     encode.`). Those are collected after each environment compiles.
 *
 * Selector rejections are not in the encoder's warnings at all (the native
 * encoder prints them to stderr), which is why the normaliser predicts them
 * from the list measured on device and removes them itself.
 */

import type { NormaliseReport, RewriteKind, SourceLocation } from './normalise.js';

export interface RemovedProperty {
  property: string;
  count: number;
  /** Where the encoder could map it back to source; often empty. */
  locations: SourceLocation[];
}

export interface CartridgeReport {
  /** The rsbuild environment the encoder warnings came from. */
  environment: string;
  stylesheets: string[];
  rewrites: Record<RewriteKind, number>;
  emitted: NormaliseReport['emitted'];
  rejectedSelectors: NormaliseReport['unsupported'];
  unsupportedSelectors: NormaliseReport['unsupported'];
  droppedMedia: NormaliseReport['droppedMedia'];
  unresolved: NormaliseReport['unresolved'];
  removedProperties: RemovedProperty[];
}

/** A compilation warning as rspack's stats give it. */
export interface WarningLike {
  message: string;
  file?: string;
  loc?: { start?: { line?: number; column?: number } } | string;
}

const REMOVED = /Unsupported property "([^"]+)" was removed during template encode/;

/** Encoder warnings → one row per removed property, most frequent first. */
export function removedProperties(warnings: WarningLike[]): RemovedProperty[] {
  const rows = new Map<string, RemovedProperty>();
  for (const w of warnings) {
    const m = REMOVED.exec(w.message);
    if (!m) continue;
    const property = m[1]!;
    const row = rows.get(property) ?? { property, count: 0, locations: [] };
    row.count++;
    const start = typeof w.loc === 'object' ? w.loc.start : undefined;
    if (w.file && start?.line !== undefined) {
      row.locations.push({ file: w.file, line: start.line, column: start.column ?? 0 });
    }
    rows.set(property, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.property.localeCompare(b.property));
}

/** Merge the normaliser's per-stylesheet reports and the encoder's warnings. */
export function buildReport(environment: string, sheets: NormaliseReport[], warnings: WarningLike[]): CartridgeReport {
  const rewrites = {} as Record<RewriteKind, number>;
  for (const sheet of sheets) {
    for (const [kind, n] of Object.entries(sheet.rewrites) as [RewriteKind, number][]) {
      rewrites[kind] = (rewrites[kind] ?? 0) + n;
    }
  }
  const all = sheets.flatMap((s) => s.unsupported);
  return {
    environment,
    stylesheets: sheets.map((s) => s.file),
    rewrites,
    // The browser defaults head every stylesheet (no source location); list them once.
    emitted: sheets
      .flatMap((s) => s.emitted)
      .filter((e, i, all) => e.loc !== null || all.findIndex((o) => o.loc === null && o.selector === e.selector && o.property === e.property) === i),
    rejectedSelectors: all.filter((u) => u.removed),
    unsupportedSelectors: all.filter((u) => !u.removed),
    droppedMedia: sheets.flatMap((s) => s.droppedMedia),
    unresolved: sheets.flatMap((s) => s.unresolved),
    removedProperties: removedProperties(warnings),
  };
}

const at = (loc: SourceLocation | null): string => (loc ? `${loc.file}:${loc.line}` : '');

/** A Markdown rendering for people; the JSON next to it is for tools. */
export function formatReport(report: CartridgeReport): string {
  const lines: string[] = [
    `# Native CSS report (${report.environment})`,
    '',
    `Stylesheets: ${report.stylesheets.join(', ') || '(none)'}`,
    '',
    '## Rewrites',
    '',
    '| rewrite | count |',
    '|---|---|',
    ...Object.entries(report.rewrites)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `| ${k} | ${n} |`),
    '',
    `## Properties the encoder removed (${report.removedProperties.length})`,
    '',
    '| property | occurrences |',
    '|---|---|',
    ...report.removedProperties.map((p) => `| \`${p.property}\` | ${p.count} |`),
    '',
    `## Selectors the encoder rejects, removed from their rules (${report.rejectedSelectors.length})`,
    '',
    ...report.rejectedSelectors.map((u) => `- \`${u.selector}\` — ${u.reason} ${at(u.loc)}`),
    '',
    `## Selectors that never match or render on device (${report.unsupportedSelectors.length})`,
    '',
    ...report.unsupportedSelectors.map((u) => `- \`${u.selector}\` — ${u.reason} ${at(u.loc)}`),
    '',
    `## @media dropped at engine 3.9 (${report.droppedMedia.length})`,
    '',
    ...report.droppedMedia.map((m) => `- \`${m.query}\` ${at(m.loc)}`),
    '',
    `## Values left as written (${report.unresolved.length})`,
    '',
    ...report.unresolved.map((u) => `- \`${u.property}: ${u.value}\` — ${u.reason} ${at(u.loc)}`),
    '',
    `## Declarations the normaliser added (${report.emitted.length})`,
    '',
    'Each is the value a browser uses for the same case; see the README\'s headless rule.',
    '',
    ...report.emitted.map((e) => `- \`${e.selector} { ${e.property}: ${e.value} }\` — ${e.cite}`),
    '',
  ];
  return lines.join('\n');
}

/** The one line printed at the end of a build. */
export function summaryLine(report: CartridgeReport): string {
  return `[@airo-js/lynx] ${report.environment}: ${report.removedProperties.length} properties removed by the encoder, ${report.rejectedSelectors.length} selectors rejected, ${report.unsupportedSelectors.length} never match, ${report.droppedMedia.length} @media dropped`;
}
