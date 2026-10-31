import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const PYRAMID = [
  '<h3>📌 Executive Summary</h3>',
  '<p>Короткая суть статьи.</p>',
  '<h3>📐 Тезисы</h3>',
  '<details><summary>Первая тема</summary>',
  '<details><summary>Подтезис A</summary>',
  '<ul><li>факт 1</li><li>факт 2</li></ul>',
  '<pre><code class="language-js">const a = 1;</code></pre>',
  '</details>',
  '<details><summary>Подтезис B</summary>',
  '<ul><li>факт 3</li></ul>',
  '</details>',
  '</details>',
  '<details><summary>Вторая тема</summary>',
  '<blockquote>цитата</blockquote>',
  '<ul><li>факт 4</li></ul>',
  '</details>',
].join('');

test('markdown export keeps the pyramid structure', () => {
  const { api } = loadUserscript();
  const md = api.pyramidToMarkdown(PYRAMID, 'Статья');

  assert.match(md, /^# Статья$/m);
  assert.match(md, /^## 📌 Executive Summary$/m);
  assert.match(md, /^## 📐 Тезисы$/m);
  assert.match(md, /^### Первая тема$/m);
  assert.match(md, /^#### Подтезис A$/m);
  assert.match(md, /^- факт 1$/m);
  assert.match(md, /```js\nconst a = 1;\n```/);
  assert.match(md, /^> цитата$/m);
});

test('org export uses org headings, lists and src blocks', () => {
  const { api } = loadUserscript();
  const org = api.pyramidToOrg(PYRAMID, 'Статья');

  assert.match(org, /^\* Статья$/m);
  assert.match(org, /^\*\* 📌 Executive Summary$/m);
  assert.match(org, /^\*\* 📐 Тезисы$/m);
  assert.match(org, /^\*\*\* Первая тема$/m);
  assert.match(org, /^\*\*\*\* Подтезис A$/m);
  assert.match(org, /^- факт 1$/m);
  assert.match(org, /#\+begin_src js\nconst a = 1;\n#\+end_src/);
  assert.match(org, /#\+begin_quote\nцитата\n#\+end_quote/);
});

test('export produces a dated slug filename', () => {
  const h = loadUserscript();
  h.document.title = 'Как работает Event Loop!';
  assert.equal(h.api.exportFilename('md'), 'kak-rabotaet-event-loop-2026-10-31.md');
  assert.equal(h.api.exportFilename('org'), 'kak-rabotaet-event-loop-2026-10-31.org');
});

test('export buttons are disabled until a pyramid is rendered', () => {
  const h = loadUserscript();
  h.api.openPanel();
  const md = q(h, '[data-export="md"]');
  const org = q(h, '[data-export="org"]');
  assert.equal(md.disabled, true);
  assert.equal(org.disabled, true);

  h.api.setPanelHtml('<h3>📌 Executive Summary</h3><p>x</p>');
  assert.equal(md.disabled, false);
  assert.equal(org.disabled, false);
});

test('export renders the sanitised pyramid, not the raw stream', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setPanelHtml(h.api.sanitizeHtml('<h3>📌 Executive Summary</h3><p>ok</p><script>alert(1)</script>'));
  const result = h.api.exportPyramid('md');
  assert.match(result.text, /ok/);
  assert.doesNotMatch(result.text, /alert\(1\)/);
  assert.match(result.filename, /\.md$/);
});

test('exportPyramid refuses when there is nothing to export', () => {
  const h = loadUserscript();
  h.api.openPanel();
  assert.equal(h.api.exportPyramid('md'), null);
});

function q(h, sel) {
  return h.window.__pyramid.__root.querySelector(sel);
}
