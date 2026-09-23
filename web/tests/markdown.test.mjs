// Tests for public/markdown.js against a minimal fake DOM (no jsdom, no deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeText {
  constructor(data) {
    this.tagName = '#text';
    this.data = String(data);
    this.children = [];
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.className = '';
  }
  append(...kids) {
    for (const kid of kids) {
      if (kid && kid.tagName === '#fragment') this.children.push(...kid.children);
      else this.children.push(kid);
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  set textContent(v) {
    this.children = String(v) === '' ? [] : [new FakeText(v)];
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('');
  }
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (data) => new FakeText(data),
  createDocumentFragment: () => new FakeElement('#fragment'),
};

const { renderMarkdown, renderLinkified } = await import('../public/markdown.js');

const root = () => new FakeElement('div');

/** All descendants (depth first) with the given tag name. */
function all(node, tag) {
  const out = [];
  for (const c of node.children) {
    if (c.tagName === tag) out.push(c);
    out.push(...all(c, tag));
  }
  return out;
}
const one = (node, tag) => all(node, tag)[0] || null;

test('inline bold and code inside a paragraph', () => {
  const el = root();
  renderMarkdown(el, 'Plan is **ready** — run `npm test` now.');
  const p = one(el, 'p');
  assert.ok(p, 'paragraph created');
  assert.equal(one(p, 'strong').textContent, 'ready');
  assert.equal(one(p, 'code').textContent, 'npm test');
  assert.equal(p.textContent, 'Plan is ready — run npm test now.');
});

test('hard line breaks inside a paragraph become <br>', () => {
  const el = root();
  renderMarkdown(el, 'one\ntwo');
  assert.equal(all(el, 'br').length, 1);
});

test('headings render as bold lines, not huge <h1>', () => {
  const el = root();
  renderMarkdown(el, '## Rezultat\n\ntext');
  const h = el.children[0];
  assert.equal(h.tagName, 'div');
  assert.equal(h.className, 'md-h md-h2');
  assert.equal(h.textContent, 'Rezultat');
});

test('fenced code block keeps content verbatim and records the language', () => {
  const el = root();
  renderMarkdown(el, 'before\n\n```js\nconst a = **1**;\n  indented\n```\n\nafter');
  const code = one(el, 'code');
  assert.equal(code.getAttribute('data-lang'), 'js');
  assert.equal(code.textContent, 'const a = **1**;\n  indented');
  assert.equal(all(el, 'strong').length, 0, 'no inline parsing inside a code fence');
  assert.equal(all(el, 'p').length, 2);
});

test('nested bullet list (one level) and checkbox markers stay plain text', () => {
  const el = root();
  renderMarkdown(el, '- top\n  - nested\n  - nested2\n- [x] done\n- [ ] todo');
  const lists = all(el, 'ul');
  assert.equal(lists.length, 2, 'outer + one nested list');
  assert.equal(lists[1].className, 'md-list md-sub');
  assert.equal(lists[1].children.length, 2);
  assert.equal(lists[0].children.length, 3);
  assert.equal(lists[0].children[1].textContent, '[x] done');
  assert.equal(all(el, 'a').length, 0);
});

test('numbered list uses <ol>', () => {
  const el = root();
  renderMarkdown(el, '1. first\n2. second');
  assert.equal(all(el, 'ol').length, 1);
  assert.equal(all(el, 'li').length, 2);
});

test('table with a separator row renders thead/tbody in a scroll wrapper', () => {
  const el = root();
  renderMarkdown(el, '| what | URL |\n| --- | --- |\n| box | http://example.com/a |\n| lt | none |');
  assert.equal(el.children[0].className, 'md-table-wrap');
  const table = one(el, 'table');
  assert.ok(table);
  assert.equal(all(el, 'th').length, 2);
  assert.equal(all(el, 'tr').length, 3);
  assert.equal(all(el, 'td').length, 4);
  assert.equal(one(el, 'a').getAttribute('href'), 'http://example.com/a');
});

test('blockquote and horizontal rule', () => {
  const el = root();
  renderMarkdown(el, '> quoted line\n> second\n\n---\n\ntail');
  assert.equal(one(el, 'blockquote').textContent, 'quoted linesecond');
  assert.equal(all(el, 'hr').length, 1);
});

test('bare URL with trailing punctuation keeps the punctuation outside the link', () => {
  const el = root();
  renderMarkdown(el, 'See http://127.0.0.1:7777/api/fleet. Done.');
  const a = one(el, 'a');
  assert.equal(a.getAttribute('href'), 'http://127.0.0.1:7777/api/fleet');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(one(el, 'p').textContent, 'See http://127.0.0.1:7777/api/fleet. Done.');
});

test('markdown link renders an anchor with its label', () => {
  const el = root();
  renderMarkdown(el, 'read [the docs](https://example.com/docs) please');
  const a = one(el, 'a');
  assert.equal(a.getAttribute('href'), 'https://example.com/docs');
  assert.equal(a.textContent, 'the docs');
});

test('javascript: and other non-http hrefs are rejected and stay plain text', () => {
  const el = root();
  renderMarkdown(el, '[click](javascript:alert(1)) and [f](file:///etc/passwd)');
  assert.equal(all(el, 'a').length, 0);
  assert.match(el.textContent, /\[click\]\(javascript:alert\(1\)\)/);
  assert.match(el.textContent, /file:\/\/\/etc\/passwd/);
});

test('renderLinkified renders plain terminal text with links only', () => {
  const el = root();
  renderLinkified(el, 'run **now** see https://example.com/x)');
  assert.equal(all(el, 'strong').length, 0);
  assert.equal(one(el, 'a').className, 'term-link');
  assert.equal(one(el, 'a').getAttribute('href'), 'https://example.com/x');
  assert.equal(el.textContent, 'run **now** see https://example.com/x)');
});

test('empty and unknown input degrade to plain text without throwing', () => {
  const el = root();
  renderMarkdown(el, '');
  assert.equal(el.children.length, 0);
  renderMarkdown(el, '<script>alert(1)</script> :: weird ~~strike~~');
  assert.equal(el.textContent, '<script>alert(1)</script> :: weird ~~strike~~');
  assert.equal(all(el, 'script').length, 0);
});
