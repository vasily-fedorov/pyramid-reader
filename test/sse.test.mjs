import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const api = () => loadUserscript().api;
const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('parses a complete single event', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  assert.equal(p.push(chunk('hello')).done, false);
  assert.equal(seen[0].choices[0].delta.content, 'hello');
});

test('reassembles an event split across chunk boundaries', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  const full = chunk('split me');
  p.push(full.slice(0, 12));
  p.push(full.slice(12, 30));
  p.push(full.slice(30));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].choices[0].delta.content, 'split me');
});

test('reports done on [DONE] and stops emitting', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  assert.equal(p.push('data: [DONE]\n\n').done, true);
  assert.equal(seen.length, 0);
});

test('ignores blank lines and comment keep-alives', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  p.push('\n\n: keep-alive\n\n');
  assert.equal(seen.length, 0);
});

test('survives a malformed json event without throwing', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  assert.doesNotThrow(() => p.push('data: {broken\n\n'));
  assert.equal(seen.length, 0);
});

test('extractDelta reads delta content and ignores role-only chunks', () => {
  const a = api();
  assert.equal(a.extractDelta({ choices: [{ delta: { content: 'x' } }] }), 'x');
  assert.equal(a.extractDelta({ choices: [{ delta: { role: 'assistant' } }] }), '');
  assert.equal(a.extractDelta({}), '');
});

test('extractDelta ignores reasoning_content from thinking models', () => {
  const a = api();
  assert.equal(a.extractDelta({ choices: [{ delta: { reasoning_content: 'hmm...' } }] }), '');
  assert.equal(a.extractDelta({ choices: [{ delta: { reasoning_content: 'hmm', content: 'ok' } }] }), 'ok');
});

test('extractUsage reads completion_tokens from the final chunk', () => {
  const a = api();
  assert.equal(a.extractUsage({ usage: { completion_tokens: 412, prompt_tokens: 900 } }), 412);
});

test('extractUsage returns null when the server sends no usage', () => {
  const a = api();
  assert.equal(a.extractUsage({ choices: [] }), null);
  assert.equal(a.extractUsage({}), null);
  assert.equal(a.extractUsage({ usage: { completion_tokens: 0 } }), null);
});

test('parseApiError maps auth failures', () => {
  const a = api();
  assert.match(a.parseApiError(401, '{"error":{"message":"bad key"}}'), /Неверный ключ API/);
  assert.match(a.parseApiError(403, ''), /Неверный ключ API/);
});

test('parseApiError maps quota and rate limits', () => {
  const a = api();
  assert.match(a.parseApiError(429, '{"error":{"message":"Rate limit reached"}}'), /Закончились токены|лимит/);
  assert.match(a.parseApiError(402, ''), /Закончились токены|лимит/);
  assert.match(a.parseApiError(400, '{"error":{"code":"insufficient_quota"}}'), /Закончились токены|лимит/);
});

test('parseApiError maps 404 to model or address', () => {
  assert.match(loadUserscript().api.parseApiError(404, ''), /Модель или адрес/);
});

test('parseApiError passes through a 400 server message', () => {
  const msg = loadUserscript().api.parseApiError(400, '{"error":{"message":"model not supported"}}');
  assert.match(msg, /model not supported/);
});

test('parseApiError maps status 0 to a network hint', () => {
  assert.match(loadUserscript().api.parseApiError(0, ''), /Не удалось связаться с API/);
});

test('parseApiError never returns raw json', () => {
  const msg = loadUserscript().api.parseApiError(500, '{"error":{"message":"boom"},"x":1}');
  assert.doesNotMatch(msg, /"x":1/);
  assert.match(msg, /boom/);
});
