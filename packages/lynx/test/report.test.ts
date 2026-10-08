import { describe, expect, it } from 'vitest';

import { normaliseCss } from '../src/build/normalise.js';
import { buildReport, formatReport, removedProperties } from '../src/build/report.js';

const warning = (property: string, file?: string): { message: string; file?: string; loc?: object } => ({
  message: `Unsupported property "${property}" was removed during template encode.`,
  ...(file ? { file, loc: { start: { line: 3, column: 5 } } } : {}),
});

describe('removedProperties', () => {
  it('counts each property the encoder removed, most frequent first', () => {
    expect(
      removedProperties([
        warning('object-fit', '/src/a.css'),
        warning('place-items'),
        warning('object-fit'),
        { message: 'something else entirely' },
      ]),
    ).toEqual([
      { property: 'object-fit', count: 2, locations: [{ file: '/src/a.css', line: 3, column: 5 }] },
      { property: 'place-items', count: 1, locations: [] },
    ]);
  });
});

describe('buildReport', () => {
  const a = normaliseCss('.a:focus-visible,.a:hover{color:red}.b[data-x*="y"]{color:red}', { filename: 'a.css' }).report;
  const b = normaliseCss('@media (min-width:40rem){.c{display:inline-flex}}.p{aspect-ratio:1}', { filename: 'b.css' }).report;
  const report = buildReport('lynx', [a, b], [warning('place-items')]);

  it('merges every stylesheet and splits rejected from never-matching selectors', () => {
    expect(report.stylesheets).toEqual(['a.css', 'b.css']);
    expect(report.rejectedSelectors.map((u) => u.selector)).toEqual(['.a:focus-visible']);
    expect(report.unsupportedSelectors.map((u) => u.selector)).toEqual(['.b[data-x*="y"]']);
    expect(report.droppedMedia).toHaveLength(1);
    expect(report.rewrites['inline-flex']).toBe(1);
    expect(report.emitted.map((e) => `${e.property}: ${e.value}`)).toEqual([
      ...['font-size: 16px', 'width: 100%', 'height: 100%', 'display: none', 'overflow: hidden'],
      ...['font-size: 16px', 'width: 100%', 'height: 100%', 'display: none', 'overflow: hidden'],
      'width: 100%',
    ]);
    expect(report.removedProperties).toEqual([{ property: 'place-items', count: 1, locations: [] }]);
  });

  it('renders every section in Markdown', () => {
    const md = formatReport(report);
    for (const heading of ['Properties the encoder removed (1)', 'Selectors the encoder rejects', 'never match', '@media dropped', 'Values left as written', 'Declarations the normaliser added (11)']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('`.a:focus-visible` — :focus-visible is rejected by the Lynx encoder a.css:1');
  });
});
