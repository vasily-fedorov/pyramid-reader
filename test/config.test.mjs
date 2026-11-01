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

test('default maxTokens leaves room for a full pyramid', () => {
  const { api } = loadUserscript();
  assert.ok(api.DEFAULT_CONFIG.maxTokens >= 8192);
});

test('thinking is off by default and configurable', () => {
  const { api } = loadUserscript();
  assert.equal(api.DEFAULT_CONFIG.thinking, false);
  assert.equal(api.saveConfig({ thinking: true }).thinking, true);
});

test('a config saved before thinking existed is migrated once', () => {
  const { api, store } = loadUserscript({ store: { 'pyr.config': { apiKey: 'k', maxTokens: 4096 } } });
  const cfg = api.loadConfig();
  assert.equal(cfg.maxTokens, 8192);
  assert.equal(cfg.thinking, false);
  assert.equal(cfg.apiKey, 'k');
  assert.equal(store.get('pyr.config').maxTokens, 8192);
});

test('an explicit maxTokens chosen after the migration is kept', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': { maxTokens: 4096, thinking: false } } });
  assert.equal(api.loadConfig().maxTokens, 4096);
});
