import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadUserscript } from './helpers/load-userscript.mjs';

const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function extract(name, opts = {}) {
  const h = loadUserscript({ html: fixture(name) });
  return h.api.extractArticle(h.document, opts);
}

test('docs page: article body without site chrome', () => {
  const r = extract('docs-with-code.html');
  assert.ok(r.usedReadability);
  assert.doesNotMatch(r.text, /Skip to content/);
  assert.doesNotMatch(r.text, /Docs \/ API/);
  assert.ok(r.text.length > 500);
});

test('docs page: code fences keep language and indentation', () => {
  const r = extract('docs-with-code.html');
  assert.match(r.text, /```python\ndef f\(\):\n {4}return 1\n```/);
  assert.match(r.text, /```bash/);
});

test('tech blog: footer and aside are not in the text', () => {
  const r = extract('tech-blog.html');
  assert.doesNotMatch(r.text, /© 2026/);
  assert.doesNotMatch(r.text, /Related/);
});

test('news page: cookie banner and subscription form are dropped', () => {
  const r = extract('news-article.html');
  assert.doesNotMatch(r.text, /Accept all cookies/);
  assert.doesNotMatch(r.text, /Subscribe to our newsletter/);
});

test('heavy framework page: sidebar menu is not in the text', () => {
  const r = extract('heavy-framework.html');
  assert.doesNotMatch(r.text, /Products/);
  assert.doesNotMatch(r.text, /Pricing/);
});

test('no-article page: short flag is set', () => {
  const r = extract('no-article.html');
  assert.equal(r.short, true);
  assert.equal(r.usedReadability, false);
});

test('truncation cuts at a paragraph boundary and reports the original length', () => {
  const para = 'A'.repeat(300);
  const html = `<!doctype html><html><body><article>${`<p>${para}</p>`.repeat(10)}</article></body></html>`;
  const h = loadUserscript({ html });
  const r = h.api.extractArticle(h.document, { maxChars: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1000);
  assert.ok(r.originalLength >= 3000);
  assert.equal(r.text.endsWith('A'), true);
  assert.doesNotMatch(r.text, /\n\n+$/);
});

test('autoExtract:false skips Readability and still returns text', () => {
  const h = loadUserscript({ html: fixture('docs-with-code.html') });
  const r = h.api.extractArticle(h.document, { autoExtract: false });
  assert.equal(r.usedReadability, false);
  assert.ok(r.text.length > 0);
});

test('no-article page: navigation is not in the fallback text', () => {
  const r = extract('no-article.html');
  assert.doesNotMatch(r.text, /Cart/);
  assert.doesNotMatch(r.text, /\bHome\b/);
});

test('code block blank lines are preserved verbatim', () => {
  const html =
    '<!doctype html><html><body><article><pre><code class="language-python">def a():\n    return 1\n\n\ndef b():\n    return 2</code></pre></article></body></html>';
  const h = loadUserscript({ html });
  const r = h.api.extractArticle(h.document, { autoExtract: false });
  assert.match(r.text, /def a\(\):\n {4}return 1\n\n\ndef b\(\):/);
});
