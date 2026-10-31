import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

test('loadConfig returns defaults when storage is empty', () => {
  const { api } = loadUserscript();
  assert.deepEqual(api.loadConfig(), api.DEFAULT_CONFIG);
});

test('loadConfig merges stored values over defaults', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': { model: 'llama3' } } });
  const cfg = api.loadConfig();
  assert.equal(cfg.model, 'llama3');
  assert.equal(cfg.apiBase, api.DEFAULT_CONFIG.apiBase);
});

test('loadConfig survives corrupt stored string', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': '{not json' } });
  assert.deepEqual(api.loadConfig(), api.DEFAULT_CONFIG);
});

test('loadConfig coerces numeric strings and clamps', () => {
  const { api } = loadUserscript({
    store: { 'pyr.config': { maxChars: '5000', temperature: '9' } },
  });
  const cfg = api.loadConfig();
  assert.equal(cfg.maxChars, 5000);
  assert.equal(cfg.temperature, 2);
});

test('saveConfig persists a patch and returns the merged config', () => {
  const { api, store } = loadUserscript();
  const cfg = api.saveConfig({ model: 'gpt-4o' });
  assert.equal(cfg.model, 'gpt-4o');
  assert.equal(store.get('pyr.config').model, 'gpt-4o');
  assert.equal(store.get('pyr.config').apiBase, api.DEFAULT_CONFIG.apiBase);
});

test('storage roundtrip, delete and keys', () => {
  const { api } = loadUserscript();
  api.storageSet('a', { x: 1 });
  assert.deepEqual(api.storageGet('a', null), { x: 1 });
  assert.equal(api.storageGet('missing', 'dflt'), 'dflt');
  assert.deepEqual(api.storageKeys(), ['a']);
  api.storageDelete('a');
  assert.deepEqual(api.storageKeys(), []);
});
