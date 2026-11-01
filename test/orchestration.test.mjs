import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const ARTICLE = `<!doctype html><html><body><article>
${'<p>The event loop lets JavaScript run non-blocking code on a single thread.</p>'.repeat(12)}
<pre><code class="language-js">setTimeout(() => {}, 0)</code></pre>
</article></body></html>`;

function setup({ store = {}, request = null } = {}) {
  const captured = [];
  const h = loadUserscript({
    html: ARTICLE,
    url: 'https://example.com/a',
    store,
    gmRequest: (d) => {
      captured.push(d);
      return request ? request(d) : { abort() {} };
    },
  });
  return { h, captured, api: h.api };
}

const sse = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

test('renders a cached pyramid without touching the API', () => {
  const { api, captured } = setup();
  api.putCached('https://example.com/a', api.__extractText(), '', '<h3>cached</h3>', 'auto');
  api.runPyramid();
  assert.equal(captured.length, 0);
  assert.match(api.__root.querySelector('#pyr-content').innerHTML, /cached/);
});

test('streams the answer into the panel and marks the state done', () => {
  const { api, captured } = setup();
  api.runPyramid();
  const d = captured[0];
  d.onprogress({ responseText: sse('<h3>📌 Executive Summary</h3>') });
  d.onprogress({ responseText: sse('<h3>📌 Executive Summary</h3>') + sse('<p>short</p>') });
  d.onload({
    responseText: sse('<h3>📌 Executive Summary</h3>') + sse('<p>short</p>') + 'data: [DONE]\n\n',
  });
  const html = api.__root.querySelector('#pyr-content').innerHTML;
  assert.match(html, /Executive Summary/);
  assert.match(html, /short/);
});

test('empty focus sends the base prompt, non-empty focus sends the focus block', () => {
  const a = setup();
  a.api.runPyramid();
  const bodyA = JSON.parse(a.captured[0].data);
  assert.doesNotMatch(bodyA.messages[0].content, /предмета интереса пользователя/);

  const b = setup();
  b.api.setFocusValue('только архитектура');
  b.api.runPyramid();
  const bodyB = JSON.parse(b.captured[0].data);
  assert.match(bodyB.messages[0].content, /только архитектура/);
});

test('focus is read from the panel input on rebuild', () => {
  const { api, captured } = setup();
  api.runPyramid();
  api.setFocusValue('go examples');
  api.runPyramid();
  const body = JSON.parse(captured[1].data);
  assert.match(body.messages[0].content, /go examples/);
});

test('a second run aborts the first request', () => {
  let aborted = 0;
  const { api } = setup({
    request: (d) => ({
      abort() {
        aborted += 1;
        d.__aborted = true;
      },
    }),
  });
  api.runPyramid();
  api.runPyramid();
  assert.equal(aborted, 1);
});

test('an API error renders the error card and keeps the focus text', () => {
  const { api, captured } = setup();
  api.setFocusValue('architecture');
  api.runPyramid();
  captured[0].onload({ status: 401, responseText: '{"error":{"message":"bad key"}}' });
  assert.match(api.__root.querySelector('#pyr-content').textContent, /Неверный ключ API/);
  assert.equal(api.getFocusValue(), 'architecture');
});

test('model output with a script tag never reaches the panel as markup', () => {
  const { api, captured } = setup();
  api.runPyramid();
  captured[0].onload({
    responseText: `data: ${JSON.stringify({ choices: [{ delta: { content: '<p>ok</p><script>alert(1)</script>' } }] })}\n\ndata: [DONE]\n\n`,
  });
  const content = api.__root.querySelector('#pyr-content');
  assert.match(content.innerHTML, /<p>ok<\/p>/);
  assert.doesNotMatch(content.innerHTML, /script/i);
});

test('successful run stores the answer in the cache for the same focus', () => {
  const { api, captured } = setup();
  const text = api.__extractText();
  api.setFocusValue('arch');
  api.runPyramid();
  captured[0].onload({
    responseText: `data: ${JSON.stringify({ choices: [{ delta: { content: '<p>done</p>' } }] })}\n\ndata: [DONE]\n\n`,
  });
  assert.match(api.getCached('https://example.com/a', text, 'arch', 'auto').html, /done/);
});

test('short extracted text shows the not-an-article warning', () => {
  const h = loadUserscript({ html: '<!doctype html><html><body><p>hi</p></body></html>' });
  h.api.runPyramid();
  assert.match(h.api.__root.querySelector('#pyr-note').textContent, /не статья/i);
});

test('rebuild bypasses the cache and calls the API', () => {
  const { api, captured } = setup();
  api.init();
  api.putCached('https://example.com/a', api.__extractText(), '', '<h3>cached</h3>', 'auto');
  api.runPyramid();
  assert.equal(captured.length, 0);
  api.__root.querySelector('button[data-action="rebuild"]').click();
  assert.equal(captured.length, 1);
});

test('a stale throttle timer from an aborted run cannot overwrite the next run', async () => {
  const { api, captured } = setup();
  api.putCached('https://example.com/a', api.__extractText(), '', '<h3>B</h3>', 'auto');

  api.runPyramid({ force: true });
  captured[0].onprogress({ responseText: sse('<h3>A</h3>') });
  api.runPyramid();
  assert.match(api.__root.querySelector('#pyr-content').innerHTML, /B/);

  await new Promise((resolve) => setTimeout(resolve, 320));
  const html = api.__root.querySelector('#pyr-content').innerHTML;
  assert.match(html, /B/);
  assert.doesNotMatch(html, /A/);
});

test('a markdown code fence from the model is stripped', () => {
  const { api, captured } = setup();
  api.runPyramid();
  const wrapped = '```html\n<h3>📌 Executive Summary</h3><p>ok</p>\n```';
  captured[0].onload({
    responseText: `data: ${JSON.stringify({ choices: [{ delta: { content: wrapped } }] })}\n\ndata: [DONE]\n\n`,
  });
  const html = api.__root.querySelector('#pyr-content').innerHTML;
  assert.doesNotMatch(html, /```/);
  assert.match(html, /Executive Summary/);
});

test('extraction note priorities', () => {
  const { api } = loadUserscript();
  const long = 'x'.repeat(500);
  assert.match(api.buildNote({ truncated: true, text: 'x', originalLength: 10000, short: false, usedReadability: true }, true), /обрезан/i);
  assert.match(api.buildNote({ truncated: false, text: 'x', originalLength: 1, short: true, usedReadability: true }, true), /не статья/i);
  assert.match(api.buildNote({ truncated: false, text: long, originalLength: 500, short: false, usedReadability: false }, true), /Readability/i);
  assert.equal(api.buildNote({ truncated: false, text: long, originalLength: 500, short: false, usedReadability: true }, true), '');
  assert.equal(api.buildNote({ truncated: false, text: long, originalLength: 500, short: false, usedReadability: false }, false), '');
});

test('the chosen language reaches the system prompt', () => {
  const { api, captured } = setup({ store: { 'pyr.config': { language: 'en' } } });
  api.runPyramid({ force: true });
  const body = JSON.parse(captured[0].data);
  assert.match(body.messages[0].content, /in English/);
});

test('changing the language does not serve the other language from cache', () => {
  const { api, captured } = setup();
  api.putCached('https://example.com/a', api.__extractText(), '', '<h3>cached</h3>', 'ru');
  api.runPyramid({ force: false, language: undefined });
  assert.equal(captured.length, 1, 'auto must not read the ru cache entry');
});
