import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadUserscript } from './helpers/load-userscript.mjs';

const DOMParser = new JSDOM('').window.DOMParser;

const s = (html) => loadUserscript().api.sanitizeHtml(html);

test('keeps allowed structure', () => {
  const out = s('<h3>T</h3><details><summary>S</summary><p>body</p></details>');
  assert.match(out, /<h3>T<\/h3>/);
  assert.match(out, /<details><summary>S<\/summary><p>body<\/p><\/details>/);
});

test('drops script with its content', () => {
  const out = s('<p>a</p><script>alert(1)</script>');
  assert.equal(out, '<p>a</p>');
});

test('drops img entirely', () => {
  assert.equal(s('<p>a<img src="x" onerror="alert(1)">b</p>'), '<p>ab</p>');
});

test('strips every attribute from allowed tags', () => {
  const out = s('<details style="margin-left:20px" open class="c"><summary id="s">x</summary></details>');
  assert.equal(out, '<details><summary>x</summary></details>');
});

test('unwraps unknown tags but keeps their text', () => {
  assert.equal(s('<p>a <a href="javascript:alert(1)">link</a> b</p>'), '<p>a link b</p>');
});

test('removes comments', () => {
  assert.equal(s('<p>a<!-- nasty -->b</p>'), '<p>ab</p>');
});

test('markdown left by the model stays literal text', () => {
  const out = s('<p>**bold** and `code`</p><pre>```html\nx\n```</pre>');
  assert.match(out, /\*\*bold\*\*/);
  assert.match(out, /```html/);
});

test('html-like text inside an article does not become markup', () => {
  const out = s('<p>Use &lt;details&gt; for disclosure.</p>');
  assert.equal(out, '<p>Use &lt;details&gt; for disclosure.</p>');
});

test('handles an unclosed stream fragment', () => {
  const out = s('<details><summary>x</summary><p>y');
  assert.match(out, /<details><summary>x<\/summary><p>y<\/p><\/details>/);
});

test('keeps data-src citations on summary and li', () => {
  const out = s('<details><summary data-src="цитата из статьи">Тезис</summary><ul><li data-src="другая цитата">факт</li></ul></details>');
  assert.match(out, /<summary data-src="цитата из статьи">/);
  assert.match(out, /<li data-src="другая цитата">/);
});

test('strips data-src from tags that are not clickable anchors', () => {
  const out = s('<div data-src="nope"><p data-src="also nope">x</p></div>');
  assert.equal(out, '<div><p>x</p></div>');
});

test('data-src cannot smuggle extra attributes', () => {
  const out = s('<li data-src="a&quot; onclick=&quot;alert(1)" onclick="alert(2)">x</li>');
  const probe = new DOMParser().parseFromString(out, 'text/html');
  const li = probe.querySelector('li');

  assert.equal(li.attributes.length, 1);
  assert.equal(li.hasAttribute('onclick'), false);
  assert.equal(li.hasAttribute('data-src'), true);
  assert.equal(li.textContent, 'x');
});

test('data-src value is capped', () => {
  const out = s('<li data-src="' + 'a'.repeat(900) + '">x</li>');
  assert.ok(out.length < 600);
});
