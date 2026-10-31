import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

function driver() {
  const captured = [];
  const h = loadUserscript({
    gmRequest: (details) => {
      captured.push(details);
      return {
        abort() {
          details.__aborted = true;
        },
      };
    },
  });
  return { api: h.api, captured };
}

const cfg = (over = {}) => ({ ...loadUserscript().api.DEFAULT_CONFIG, apiKey: 'sk-test', ...over });

function run(over = {}) {
  const { api, captured } = driver();
  const events = { deltas: [], done: [], usage: [], errors: [], waiting: 0 };
  const handle = api.requestCompletion({
    config: cfg(over),
    system: 'SYS',
    user: 'USER',
    onDelta: (d) => events.deltas.push(d),
    onDone: (h, u) => {
      events.done.push(h);
      events.usage.push(u);
    },
    onError: (e) => events.errors.push(e),
    onWaiting: () => {
      events.waiting += 1;
    },
  });
  return { api, captured, events, handle };
}

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('sends bearer header, stream flag and both messages', () => {
  const { captured } = run();
  const d = captured[0];
  assert.equal(d.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(d.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(d.data);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.messages[1].content, 'USER');
});

test('trims trailing slash from apiBase', () => {
  const { captured } = run({ apiBase: 'http://localhost:11434/v1/' });
  assert.equal(captured[0].url, 'http://localhost:11434/v1/chat/completions');
});

test('omits Authorization when apiKey is empty', () => {
  const { captured } = run({ apiKey: '' });
  assert.equal('Authorization' in captured[0].headers, false);
});

test('accumulates deltas and calls onDone with full html', () => {
  const { captured, events } = run();
  const d = captured[0];
  d.onprogress({ responseText: sse('<h3>Hi</h3>') });
  d.onprogress({ responseText: sse('<h3>Hi</h3>') + sse('<p>body</p>') });
  d.onload({ responseText: sse('<h3>Hi</h3>') + sse('<p>body</p>') + 'data: [DONE]\n\n' });
  assert.deepEqual(events.deltas, ['<h3>Hi</h3>', '<p>body</p>']);
  assert.equal(events.done[0], '<h3>Hi</h3><p>body</p>');
  assert.deepEqual(events.errors, []);
});

test('thinking chunks call onWaiting once and never reach onDelta', () => {
  const { captured, events } = run();
  const d = captured[0];
  const reasoning = (t) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n\n`;
  d.onprogress({ responseText: reasoning('let me think') });
  d.onprogress({ responseText: reasoning('let me think') + reasoning('more') });
  d.onprogress({ responseText: reasoning('let me think') + reasoning('more') + sse('<p>x</p>') });
  assert.equal(events.waiting, 1);
  assert.deepEqual(events.deltas, ['<p>x</p>']);
});

test('final usage is passed to onDone', () => {
  const { captured, events } = run();
  captured[0].onload({
    responseText: sse('<p>x</p>') + `data: ${JSON.stringify({ usage: { completion_tokens: 77 } })}\n\ndata: [DONE]\n\n`,
  });
  assert.equal(events.done[0], '<p>x</p>');
  assert.equal(events.usage[0], 77);
});

test('onDone receives null usage when the server sends none', () => {
  const { captured, events } = run();
  captured[0].onload({ responseText: sse('<p>x</p>') + 'data: [DONE]\n\n' });
  assert.equal(events.usage[0], null);
});

test('falls back to a plain json response body', () => {
  const { captured, events } = run();
  captured[0].onload({
    responseText: JSON.stringify({ choices: [{ message: { content: '<p>plain</p>' } }] }),
  });
  assert.equal(events.done[0], '<p>plain</p>');
});

test('surfaces a 401 as a readable message', () => {
  const { captured, events } = run();
  captured[0].onload({ status: 401, responseText: '{"error":{"message":"bad key"}}' });
  assert.match(events.errors[0], /Неверный ключ API/);
});

test('abort suppresses the following error callback', () => {
  const { captured, events, handle } = run();
  const d = captured[0];
  handle.abort();
  assert.equal(d.__aborted, true);
  d.onerror({ error: 'aborted' });
  assert.deepEqual(events.errors, []);
});

test('network error maps to a connection hint', () => {
  const { captured, events } = run();
  captured[0].onerror({ error: 'network' });
  assert.match(events.errors[0], /Не удалось связаться с API/);
});

test('timeout triggers the timeout message', () => {
  const { captured, events } = run();
  captured[0].ontimeout();
  assert.match(events.errors[0], /Не удалось связаться с API|таймаут/i);
});
