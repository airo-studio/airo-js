// @vitest-environment node
/**
 * renderDocument.
 *
 * The environment pragma above is load-bearing, not incidental. The rest of
 * this package's suite runs under happy-dom, which supplies
 * `globalThis.document` — so an implementation that reached for
 * `document.createElement` to build tags would pass every other test in the
 * repo while breaking the package's headline property (runtime-agnostic:
 * Workers, Deno, Lambda, bare Node). Running these under `node` is the only
 * mechanical guard on that claim.
 *
 * Two invariants get their own named tests because they are the ones a
 * future "helpful" edit would break:
 *
 *   - NO viewport tag by default. That string is responsive-design policy,
 *     not correctness, and the framework authors no visual defaults.
 *   - ZERO `<style>` tags by default. `inlineStyles` is caller passthrough;
 *     the framework ships no CSS.
 */

import { describe, expect, test } from 'vitest';

import { buildJsonLdScript } from '../src/build-json-ld-script.js';
import { renderDocument } from '../src/render-document.js';

const minimal = { head: { lang: 'en' }, body: '' };

describe('renderDocument — document shell', () => {
  test('emits a doctype first, exactly once', () => {
    const html = renderDocument(minimal);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.match(/<!doctype/gi)).toHaveLength(1);
  });

  test('renders a complete, minimal document from lang alone', () => {
    expect(renderDocument(minimal)).toBe(
      [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '</head>',
        '<body>',
        '',
        '</body>',
        '</html>',
      ].join('\n'),
    );
  });

  test('lang and dir land on <html>, attribute-escaped', () => {
    const html = renderDocument({ head: { lang: 'ar', dir: 'rtl' }, body: '' });
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  test('htmlAttrs and bodyAttrs pass through', () => {
    const html = renderDocument({
      ...minimal,
      htmlAttrs: { 'data-theme': 'dark' },
      bodyAttrs: { class: 'site' },
    });
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('<body class="site">');
  });

  test('newline: "" produces single-line output', () => {
    expect(renderDocument({ ...minimal, newline: '' })).not.toContain('\n');
  });

  test('body is passed through byte-for-byte', () => {
    const body = '<script type="application/ld+json">{"@type":"Product"}</script>\n<div>widget</div>';
    expect(renderDocument({ head: { lang: 'en' }, body })).toContain(body);
  });

  test('is deterministic', () => {
    const opts = { head: { lang: 'en', title: 'T', openGraph: { 'og:title': 'T' } }, body: 'x' };
    expect(renderDocument(opts)).toBe(renderDocument(opts));
  });
});

describe('renderDocument — charset', () => {
  test('defaults to utf-8 as the first head child', () => {
    const html = renderDocument(minimal);
    expect(html).toContain('<head>\n<meta charset="utf-8">');
  });

  test('lands inside the first 1024 bytes, where sniffing parsers stop looking', () => {
    const html = renderDocument({
      head: { lang: 'en', title: 'x'.repeat(4000) },
      body: '',
    });
    expect(html.indexOf('<meta charset=')).toBeLessThan(1024);
  });

  test('charset: false omits it', () => {
    expect(renderDocument({ head: { lang: 'en', charset: false }, body: '' })).not.toContain(
      'charset',
    );
  });

  test('an explicit charset is honoured', () => {
    expect(renderDocument({ head: { lang: 'en', charset: 'iso-8859-1' }, body: '' })).toContain(
      '<meta charset="iso-8859-1">',
    );
  });
});

describe('renderDocument — headless invariants', () => {
  test('NO viewport tag by default — that string is policy, not correctness', () => {
    expect(renderDocument(minimal)).not.toContain('viewport');
  });

  test('an explicitly supplied viewport is emitted', () => {
    const html = renderDocument({
      head: { lang: 'en', viewport: 'width=device-width, initial-scale=1' },
      body: '',
    });
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  test('ZERO <style> tags by default — the framework authors no CSS', () => {
    expect(renderDocument(minimal)).not.toContain('<style');
  });

  test('caller CSS is emitted verbatim and untransformed', () => {
    const css = '.a{color:red}/* keep  this   spacing */';
    const html = renderDocument({ head: { lang: 'en', inlineStyles: [css] }, body: '' });
    expect(html).toContain(`<style>${css}</style>`);
  });

  test('multiple stylesheets keep their order', () => {
    const html = renderDocument({
      head: { lang: 'en', inlineStyles: ['.a{}', '.b{}'] },
      body: '',
    });
    expect(html.indexOf('.a{}')).toBeLessThan(html.indexOf('.b{}'));
  });
});

describe('renderDocument — escaping', () => {
  test('title escapes all five characters', () => {
    expect(renderDocument({ head: { lang: 'en', title: `a&b<c>d"e'f` }, body: '' })).toContain(
      '<title>a&amp;b&lt;c&gt;d&quot;e&#39;f</title>',
    );
  });

  test('a title cannot break out of its element', () => {
    const html = renderDocument({
      head: { lang: 'en', title: '</title><script>alert(1)</script>' },
      body: '',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/title&gt;');
  });

  test('attribute values cannot break out — the real XSS surface', () => {
    const html = renderDocument({
      head: { lang: 'en', canonical: 'https://x.test/" onload="alert(1)' },
      body: '',
    });
    expect(html).not.toMatch(/onload="alert/);
    expect(html).toContain('&quot; onload=&quot;');
  });

  test('a hostile lang cannot inject an attribute', () => {
    const html = renderDocument({ head: { lang: '" onload="alert(1)' }, body: '' });
    expect(html).not.toMatch(/onload="alert/);
  });

  test('empty title still emits the element', () => {
    expect(renderDocument({ head: { lang: 'en', title: '' }, body: '' })).toContain(
      '<title></title>',
    );
  });
});

describe('renderDocument — meta, links, canonical', () => {
  test('name / property / httpEquiv precedence', () => {
    const html = renderDocument({
      head: {
        lang: 'en',
        meta: [
          { name: 'description', content: 'd' },
          { property: 'og:custom', content: 'p' },
          { httpEquiv: 'content-security-policy', content: 'default-src self' },
        ],
      },
      body: '',
    });
    expect(html).toContain('<meta name="description" content="d">');
    expect(html).toContain('<meta property="og:custom" content="p">');
    expect(html).toContain('<meta http-equiv="content-security-policy" content="default-src self">');
  });

  test('a meta with no key is skipped rather than emitted broken', () => {
    expect(renderDocument({ head: { lang: 'en', meta: [{ content: 'orphan' }] }, body: '' })).not.toContain(
      'orphan',
    );
  });

  test('canonical emits one link', () => {
    const html = renderDocument({ head: { lang: 'en', canonical: 'https://x.test/a' }, body: '' });
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  test('links carry extra attributes', () => {
    const html = renderDocument({
      head: {
        lang: 'en',
        links: [{ rel: 'alternate', href: 'https://x.test/fr', attrs: { hreflang: 'fr' } }],
      },
      body: '',
    });
    expect(html).toContain('<link rel="alternate" href="https://x.test/fr" hreflang="fr">');
  });

  test('does NOT dedupe a canonical also present in links — stays dumb, documented', () => {
    const html = renderDocument({
      head: {
        lang: 'en',
        canonical: 'https://x.test/a',
        links: [{ rel: 'canonical', href: 'https://x.test/a' }],
      },
      body: '',
    });
    expect(html.match(/rel="canonical"/g)).toHaveLength(2);
  });
});

describe('renderDocument — OpenGraph vs Twitter attribute form', () => {
  // A real spec difference that every hand-rolled shell in this repo got
  // wrong. It is why these are two fields rather than one meta[].
  test('openGraph uses property=, twitter uses name=', () => {
    const html = renderDocument({
      head: {
        lang: 'en',
        openGraph: { 'og:title': 'T' },
        twitter: { 'twitter:card': 'summary' },
      },
      body: '',
    });
    expect(html).toContain('<meta property="og:title" content="T">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  test('the form is decided by the FIELD, not by sniffing the key prefix', () => {
    // A key that does not look like og:/twitter: still follows its field.
    const html = renderDocument({
      head: { lang: 'en', openGraph: { weird: 'v' }, twitter: { alsoweird: 'v' } },
      body: '',
    });
    expect(html).toContain('<meta property="weird" content="v">');
    expect(html).toContain('<meta name="alsoweird" content="v">');
  });
});

describe('renderDocument — JSON-LD', () => {
  test('is byte-identical to buildJsonLdScript — one emitter, no drift', () => {
    const payload = { '@type': 'Product', name: 'x</script>' };
    expect(renderDocument({ head: { lang: 'en', jsonLd: [payload] }, body: '' })).toContain(
      buildJsonLdScript(payload),
    );
  });

  test('escapes the closing-script sequence', () => {
    const html = renderDocument({
      head: { lang: 'en', jsonLd: [{ name: '</script><img src=x>' }] },
      body: '',
    });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script');
  });
});

describe('renderDocument — scripts and raw', () => {
  test('script attributes', () => {
    const html = renderDocument({
      head: {
        lang: 'en',
        scripts: [{ src: '/app.js', type: 'module', defer: true, nonce: 'abc' }],
      },
      body: '',
    });
    expect(html).toContain('<script type="module" src="/app.js" defer nonce="abc"></script>');
  });

  test('bodyScripts land after the body content', () => {
    const html = renderDocument({
      head: { lang: 'en' },
      body: '<div id="app"></div>',
      bodyScripts: [{ src: '/client.js', type: 'module' }],
    });
    expect(html.indexOf('<div id="app">')).toBeLessThan(html.indexOf('/client.js'));
  });

  test('raw is verbatim and emitted LAST so it wins', () => {
    const html = renderDocument({
      head: { lang: 'en', title: 'T', raw: '<meta name="x" content="y">' },
      body: '',
    });
    expect(html).toContain('<meta name="x" content="y">');
    expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('name="x"'));
  });
});

describe('renderDocument — breakout guard', () => {
  test('inline CSS containing </style throws rather than mangling', () => {
    expect(() =>
      renderDocument({ head: { lang: 'en', inlineStyles: ['a{}</style><script>x'] }, body: '' }),
    ).toThrow(/would end the element early/);
  });

  test('the guard is case- and whitespace-insensitive', () => {
    expect(() =>
      renderDocument({ head: { lang: 'en', inlineStyles: ['a{}</ STYLE >'] }, body: '' }),
    ).toThrow(/would end the element early/);
  });

  test('inline JS containing </script throws', () => {
    expect(() =>
      renderDocument({
        head: { lang: 'en', scripts: [{ content: 'var a = "</script>";' }] },
        body: '',
      }),
    ).toThrow(/would end the element early/);
  });

  test('the error names the field and says why escaping is not the fix', () => {
    expect(() =>
      renderDocument({ head: { lang: 'en', inlineStyles: ['</style>'] }, body: '' }),
    ).toThrow(/emitted verbatim \(escaping it would corrupt the CSS\)/);
  });

  test('ordinary CSS and JS pass', () => {
    expect(() =>
      renderDocument({
        head: {
          lang: 'en',
          inlineStyles: ['.a::after{content:"<"}'],
          scripts: [{ content: 'if (a < b) { go(); }' }],
        },
        body: '',
      }),
    ).not.toThrow();
  });

  test('the guard does NOT apply to body — that is rendered markup', () => {
    expect(() =>
      renderDocument({ head: { lang: 'en' }, body: '<script>ok()</script>' }),
    ).not.toThrow();
  });
});

describe('renderDocument — head emission order', () => {
  test('charset → title → canonical → og → twitter → styles → raw', () => {
    const html = renderDocument({
      head: {
        lang: 'en',
        title: 'T',
        canonical: 'https://x.test/a',
        openGraph: { 'og:title': 'T' },
        twitter: { 'twitter:card': 'summary' },
        inlineStyles: ['.a{}'],
        raw: '<!--last-->',
      },
      body: '',
    });
    const at = (s: string) => html.indexOf(s);
    expect(at('charset')).toBeLessThan(at('<title>'));
    expect(at('<title>')).toBeLessThan(at('rel="canonical"'));
    expect(at('rel="canonical"')).toBeLessThan(at('og:title'));
    expect(at('og:title')).toBeLessThan(at('twitter:card'));
    expect(at('twitter:card')).toBeLessThan(at('<style>'));
    expect(at('<style>')).toBeLessThan(at('<!--last-->'));
  });
});
