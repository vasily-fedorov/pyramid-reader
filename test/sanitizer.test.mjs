import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

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
