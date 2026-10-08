import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noopSink, resetSink, setSink } from '@airo-js/log';

import { type El, type Page, page } from './harness.js';

let p: Page;
beforeEach(() => setSink(noopSink));
afterEach(() => {
  p?.fake.uninstall();
  resetSink();
});

describe('links', () => {
  it('a tapped link asks the host for its href', () => {
    p = page('<nav><a class="l" href="/doc/x"><span>Read</span></a></nav>');
    p.tap('.l');
    expect(p.navigate).toHaveBeenCalledWith({ url: '/doc/x', method: 'get', fields: {}, source: 'link' });
  });

  it('a click handler that prevents the default keeps the page', () => {
    p = page('<a class="l" href="/x">x</a>');
    p.root.addEventListener('click', (e: El) => e.preventDefault());
    p.tap('.l');
    expect(p.navigate).not.toHaveBeenCalled();
  });

  it('fragment and javascript: links do not navigate', () => {
    p = page('<a class="f" href="#top">top</a><a class="j" href="javascript:void(0)">j</a>');
    p.tap('.f');
    p.tap('.j');
    expect(p.navigate).not.toHaveBeenCalled();
  });

  it('a link inside running text is tapped through its nested text', () => {
    p = page('<p class="t">See <a class="in" href="/terms">the terms</a>.</p>');
    p.tap('.in');
    expect(p.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: '/terms' }));
  });
});

describe('forms', () => {
  it('the tracer: tapping join posts the invite code', () => {
    p = page(readFileSync(new URL('./fixtures/invite.html', import.meta.url), 'utf8'));
    p.tap('button[type="submit"]', 1); // the label's text wrapper
    expect(p.navigate).toHaveBeenCalledWith({
      url: '/api/groups/join',
      method: 'post',
      fields: { code: 'SPIKE1' },
      source: 'form',
    });
  });

  it('serialises fields by the HTML rules: typed values, repeats, disabled, the submitter', () => {
    p = page(
      [
        '<form action="/s" method="post">',
        '<input type="hidden" name="t" value="1"><input type="hidden" name="t" value="2">',
        '<input class="q" name="q" value="old"><input name="off" value="x" disabled>',
        '<fieldset disabled><input name="inside" value="y"></fieldset>',
        '<textarea name="note">hi</textarea><input value="unnamed">',
        '<button class="go" name="action" value="save">Save</button><button name="other" value="no">Other</button>',
        '</form>',
      ].join(''),
    );
    p.fake.fire(p.native('.q'), 'input', { value: 'typed' });
    p.tap('.go');
    expect(p.navigate).toHaveBeenCalledWith({
      url: '/s',
      method: 'post',
      fields: { t: ['1', '2'], q: 'typed', note: 'hi', action: 'save' },
      source: 'form',
    });
  });

  it('formaction and formmethod on the submitter win', () => {
    p = page('<form action="/a" method="post"><button class="b" formaction="/b" formmethod="get">b</button></form>');
    p.tap('.b');
    expect(p.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: '/b', method: 'get' }));
  });

  it('runs the click, then a cancellable submit, then the request', () => {
    p = page('<form class="f" action="/s"><button class="b">Go</button></form>');
    const order: string[] = [];
    p.root.addEventListener('click', () => order.push('click'));
    p.root.addEventListener('submit', (e: El) => {
      order.push(`submit submitter=${e.submitter.tagName}`);
      e.preventDefault();
    });
    p.tap('.b');
    expect(order).toEqual(['click', 'submit submitter=BUTTON']);
    expect(p.navigate).not.toHaveBeenCalled();
  });

  it('a type="button" or disabled button does not submit', () => {
    p = page('<form action="/s"><button class="plain" type="button">x</button><button class="off" disabled>y</button></form>');
    const click = vi.fn();
    p.root.addEventListener('click', click);
    p.tap('.plain');
    p.tap('.off');
    expect(click).toHaveBeenCalledTimes(1);
    expect(p.navigate).not.toHaveBeenCalled();
  });

  it('return in a text field clicks the default button', () => {
    p = page('<form action="/search"><input class="q" name="q"><button class="b">Search</button></form>');
    const clicks = vi.fn();
    p.root.querySelector('.b').addEventListener('click', clicks);
    p.fake.fire(p.native('.q'), 'confirm', { value: 'chair' });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(p.navigate).toHaveBeenCalledWith({ url: '/search', method: 'get', fields: { q: 'chair' }, source: 'form' });
  });

  it('return in the only field of a form with no button submits it; with two fields it does not', () => {
    p = page('<form class="one" action="/one"><input class="q" name="q"></form><form action="/two"><input class="a" name="a"><input name="b"></form>');
    p.fake.fire(p.native('.q'), 'confirm', { value: 'x' });
    p.fake.fire(p.native('.a'), 'confirm', { value: 'y' });
    expect(p.navigate).toHaveBeenCalledTimes(1);
    expect(p.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: '/one', fields: { q: 'x' } }));
  });
});
