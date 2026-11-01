import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const PAGE = `<!doctype html><html><head><title>Статья</title></head><body>
<nav><a href="/">Главная страница сайта</a></nav>
<article>
  <p>Цикл событий позволяет JavaScript выполнять неблокирующий код в одном потоке.</p>
  <p>Микрозадачи выполняются раньше макрозадач, поэтому промис резолвится раньше таймера с нулевой задержкой.</p>
  <p>Блокирующий код останавливает всё: пока цикл работает, таймеры не срабатывают.</p>
</article>
<footer>Подвал сайта</footer>
</body></html>`;

function boot() {
  const h = loadUserscript({ html: PAGE });
  h.api.openPanel();
  return h;
}

test('findArticleMatch finds a verbatim phrase and returns its element', () => {
  const h = boot();
  const hit = h.api.findArticleMatch('Микрозадачи выполняются раньше макрозадач');
  assert.ok(hit);
  assert.equal(hit.element.tagName, 'P');
  assert.match(hit.element.textContent, /промис резолвится раньше таймера/);
});

test('findArticleMatch ignores case, punctuation and extra whitespace', () => {
  const h = boot();
  const hit = h.api.findArticleMatch('  микрозадачи   ВЫПОЛНЯЮТСЯ, раньше макрозадач!  ');
  assert.ok(hit);
  assert.equal(hit.element.tagName, 'P');
});

test('findArticleMatch does not match inside navigation or footer', () => {
  const h = boot();
  assert.equal(h.api.findArticleMatch('Главная страница сайта'), null);
  assert.equal(h.api.findArticleMatch('Подвал сайта'), null);
});

test('findArticleMatch falls back to a shorter prefix when the tail is wrong', () => {
  const h = boot();
  const hit = h.api.findArticleMatch('Блокирующий код останавливает всё и ломает интерфейс навсегда');
  assert.ok(hit);
  assert.equal(hit.element.tagName, 'P');
});

test('findArticleMatch returns null for unrelated text', () => {
  const h = boot();
  assert.equal(h.api.findArticleMatch('совершенно посторонний набор слов'), null);
});

test('findArticleMatch ignores the panel and script content', () => {
  const h = boot();
  h.api.setPanelHtml('<p>уникальная строка только внутри панели</p>');
  assert.equal(h.api.findArticleMatch('уникальная строка только внутри панели'), null);
});

test('jumpToSource scrolls the page to the match and flashes an overlay', () => {
  const h = boot();
  const calls = [];
  const p = h.document.querySelectorAll('article p')[1];
  p.scrollIntoView = (opts) => calls.push(opts);

  assert.equal(h.api.jumpToSource('Микрозадачи выполняются раньше макрозадач'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].block, 'center');
  assert.ok(h.document.querySelector('.pyr-source-hit'));
});

test('jumpToSource returns false and reports when nothing matches', () => {
  const h = boot();
  assert.equal(h.api.jumpToSource('нет такой фразы в статье вообще'), false);
});

test('clicking a summary with data-src jumps to the cited place', () => {
  const h = boot();
  const calls = [];
  h.document.querySelectorAll('article p')[0].scrollIntoView = (opts) => calls.push(opts);

  h.api.setPanelHtml(
    '<details><summary data-src="Цикл событий позволяет JavaScript выполнять неблокирующий код">Тезис</summary><p>x</p></details>',
  );
  h.api.__root.querySelector('summary').click();
  assert.equal(calls.length, 1);
});

test('clicking a fact without data-src falls back to its own text', () => {
  const h = boot();
  const calls = [];
  h.document.querySelectorAll('article p')[2].scrollIntoView = (opts) => calls.push(opts);

  h.api.setPanelHtml('<ul><li>Блокирующий код останавливает всё: пока цикл работает, таймеры не срабатывают.</li></ul>');
  h.api.__root.querySelector('li').click();
  assert.equal(calls.length, 1);
});

test('a click that finds nothing leaves a transient note', () => {
  const h = boot();
  h.api.setPanelHtml('<ul><li>фраза, которой в статье нет</li></ul>');
  h.api.__root.querySelector('li').click();
  assert.match(h.api.__root.querySelector('#pyr-note').textContent, /не наш[её]л/i);
});

test('finds the article when the model paraphrases the start of the citation', () => {
  const h = boot();
  const hit = h.api.findArticleMatch(
    'Установка требует менеджера юзерскриптов, поэтому микрозадачи выполняются раньше макрозадач',
  );
  assert.ok(hit, 'an interior matching run must be found');
  assert.match(hit.element.textContent, /Микрозадачи выполняются раньше/);
});

test('an interior run of three words is enough', () => {
  const h = boot();
  const hit = h.api.findArticleMatch('совершенно другой текст про микрозадачи выполняются раньше и прочее');
  assert.ok(hit);
  assert.match(hit.element.textContent, /Микрозадачи выполняются раньше макрозадач/);
});

test('two matching words are not enough to jump', () => {
  const h = boot();
  assert.equal(h.api.findArticleMatch('макрозадач совершенно'), null);
});
