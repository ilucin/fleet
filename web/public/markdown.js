// Safe Markdown → DOM renderer for the subset Claude Code actually emits.
// Every node is built with createElement/createTextNode and filled via
// textContent — innerHTML is never used with data. Unknown constructs fall
// back to plain text. Shared with the terminal view via renderLinkified().

const URL_RE = /https?:\/\/[^\s<>"'`…]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;
// One alternation, no nested quantifiers: code | **b** | __b__ | [t](u) | *i* | _i_
const INLINE_RE = /`([^`\n]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]\n]*)\]\(([^)\s]*)\)|\*([^*\n]+)\*|_([^_\n]+)_/g;
const ITEM_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const HEAD_RE = /^(#{1,3})\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s*```(.*)$/;
const QUOTE_RE = /^\s*>/;

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

const txt = (s) => document.createTextNode(s);

/** Only http(s) links are ever turned into anchors; anything else stays text. */
function safeHref(raw) {
  const u = String(raw == null ? '' : raw).trim();
  return /^https?:\/\/\S/i.test(u) ? u : null;
}

function anchor(href, label, cls) {
  const a = el('a', cls);
  a.setAttribute('href', href);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener noreferrer');
  a.textContent = label;
  return a;
}

/** Append `str` to `parent`, turning bare http(s) URLs into links. */
export function linkifyInto(parent, str, cls = 'md-link') {
  let last = 0;
  for (const m of String(str).matchAll(URL_RE)) {
    let url = m[0].replace(TRAILING_PUNCT, '');
    // keep one closing ")" when the URL itself opened a "(" (wikipedia-style)
    if (m[0][url.length] === ')' && url.split('(').length > url.split(')').length) url += ')';
    if (m.index > last) parent.append(txt(String(str).slice(last, m.index)));
    parent.append(anchor(url, url, cls));
    last = m.index + url.length;
  }
  const s = String(str);
  if (last < s.length) parent.append(txt(s.slice(last)));
}

/** Plain text with links — used by the terminal view (no markdown at all). */
export function renderLinkified(node, str) {
  node.textContent = '';
  const frag = document.createDocumentFragment();
  linkifyInto(frag, String(str == null ? '' : str), 'term-link');
  node.append(frag);
}

function renderInline(parent, str, depth = 0) {
  const s = String(str == null ? '' : str);
  if (depth > 3) {
    linkifyInto(parent, s);
    return;
  }
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    if (m.index < last) continue;
    // `_snake_case_` inside a word is not emphasis
    if (m[7] !== undefined && m.index > 0 && /\w/.test(s[m.index - 1])) continue;
    let node = null;
    if (m[1] !== undefined) {
      node = el('code', 'md-code-inline');
      node.textContent = m[1];
    } else if (m[2] !== undefined || m[3] !== undefined) {
      node = el('strong', 'md-strong');
      renderInline(node, m[2] !== undefined ? m[2] : m[3], depth + 1);
    } else if (m[5] !== undefined) {
      const href = safeHref(m[5]);
      if (!href) continue; // e.g. javascript: — leave the whole construct as text
      node = anchor(href, '', 'md-link');
      renderInline(node, m[4] || href, depth + 1);
    } else {
      node = el('em', 'md-em');
      renderInline(node, m[6] !== undefined ? m[6] : m[7], depth + 1);
    }
    if (m.index > last) linkifyInto(parent, s.slice(last, m.index));
    parent.append(node);
    last = m.index + m[0].length;
  }
  if (last < s.length) linkifyInto(parent, s.slice(last));
}

function isBlockStart(line) {
  return FENCE_RE.test(line) || HEAD_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || ITEM_RE.test(line);
}

function isTableSep(line) {
  const s = String(line || '');
  return /^[\s|:-]+$/.test(s) && s.includes('-') && s.includes('|') && s.trim() !== '';
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]);
}

function splitRow(line) {
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function codeBlock(frag, lines, start, lang) {
  const buf = [];
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    if (/^\s*```\s*$/.test(lines[i])) { i += 1; break; }
    buf.push(lines[i]);
  }
  const pre = el('pre', 'md-pre');
  const code = el('code', 'md-code');
  if (lang) code.setAttribute('data-lang', lang);
  code.textContent = buf.join('\n');
  pre.append(code);
  frag.append(pre);
  return i;
}

function listBlock(frag, lines, start) {
  let i = start;
  const items = [];
  while (i < lines.length) {
    const m = ITEM_RE.exec(lines[i]);
    if (!m) break;
    items.push({ indent: m[1].length, ordered: m[2] === undefined, text: m[4] });
    i += 1;
  }
  const root = el(items[0].ordered ? 'ol' : 'ul', 'md-list');
  let sub = null;
  let lastLi = null;
  for (const it of items) {
    if (it.indent >= 2 && lastLi) {
      if (!sub) {
        sub = el(it.ordered ? 'ol' : 'ul', 'md-list md-sub');
        lastLi.append(sub);
      }
      const li = el('li');
      renderInline(li, it.text);
      sub.append(li);
    } else {
      sub = null;
      lastLi = el('li');
      renderInline(lastLi, it.text);
      root.append(lastLi);
    }
  }
  frag.append(root);
  return i;
}

function quoteBlock(frag, lines, start) {
  let i = start;
  const bq = el('blockquote', 'md-quote');
  let first = true;
  while (i < lines.length && QUOTE_RE.test(lines[i])) {
    if (!first) bq.append(el('br'));
    renderInline(bq, lines[i].replace(/^\s*>\s?/, ''));
    first = false;
    i += 1;
  }
  frag.append(bq);
  return i;
}

function tableBlock(frag, lines, start) {
  const wrap = el('div', 'md-table-wrap');
  const table = el('table', 'md-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const cell of splitRow(lines[start])) {
    const th = el('th');
    renderInline(th, cell);
    hrow.append(th);
  }
  thead.append(hrow);
  table.append(thead);
  const tbody = el('tbody');
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const tr = el('tr');
    for (const cell of splitRow(lines[i])) {
      const td = el('td');
      renderInline(td, cell);
      tr.append(td);
    }
    tbody.append(tr);
    i += 1;
  }
  table.append(tbody);
  wrap.append(table);
  frag.append(wrap);
  return i;
}

function paragraph(frag, lines, start) {
  let i = start;
  const buf = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; break; }
    if (buf.length && (isBlockStart(line) || isTableStart(lines, i))) break;
    buf.push(line);
    i += 1;
  }
  const p = el('p', 'md-p');
  buf.forEach((line, k) => {
    if (k) p.append(el('br'));
    renderInline(p, line.trim());
  });
  frag.append(p);
  return i;
}

/** Render markdown `src` into `node`, replacing its contents. */
export function renderMarkdown(node, src) {
  node.textContent = '';
  const frag = document.createDocumentFragment();
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = FENCE_RE.exec(line);
    if (fence) { i = codeBlock(frag, lines, i, fence[1].trim()); continue; }
    const head = HEAD_RE.exec(line);
    if (head) {
      const hEl = el('div', `md-h md-h${head[1].length}`);
      renderInline(hEl, head[2].trim());
      frag.append(hEl);
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) { frag.append(el('hr', 'md-hr')); i += 1; continue; }
    if (QUOTE_RE.test(line)) { i = quoteBlock(frag, lines, i); continue; }
    if (ITEM_RE.test(line)) { i = listBlock(frag, lines, i); continue; }
    if (isTableStart(lines, i)) { i = tableBlock(frag, lines, i); continue; }
    i = paragraph(frag, lines, i);
  }
  node.append(frag);
}
