import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const URL_ = 'https://example.com/a';
const TEXT = 'Article body text.';

test('cacheKey is stable for identical input and differs by focus', () => {
  const { api } = loadUserscript();
  assert.equal(api.cacheKey(URL_, TEXT, ''), api.cacheKey(URL_, TEXT, ''));
  assert.notEqual(api.cacheKey(URL_, TEXT, ''), api.cacheKey(URL_, TEXT, 'architecture'));
  assert.notEqual(api.cacheKey(URL_, TEXT, ''), api.cacheKey('https://example.com/b', TEXT, ''));
});

test('cacheKey is prefixed', () => {
  const { api } = loadUserscript();
  assert.ok(api.cacheKey(URL_, TEXT, '').startsWith('pyr.cache.'));
});

test('putCached then getCached returns the html', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  assert.equal(api.getCached(URL_, TEXT, '').html, '<h3>x</h3>');
});

test('getCached returns null for a different focus', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  assert.equal(api.getCached(URL_, TEXT, 'only code'), null);
});

test('getCached drops entries past the TTL', () => {
  const { api, store } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  const key = api.cacheKey(URL_, TEXT, '');
  store.get(key).ts = Date.now() - api.CACHE_TTL_MS - 1000;
  assert.equal(api.getCached(URL_, TEXT, ''), null);
  assert.equal(store.has(key), false);
});

test('putCached truncates html to CACHE_MAX_BYTES', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', 'x'.repeat(api.CACHE_MAX_BYTES + 5000));
  assert.equal(api.getCached(URL_, TEXT, '').html.length, api.CACHE_MAX_BYTES);
});

test('pruneCache keeps only the 10 newest entries', () => {
  const { api } = loadUserscript();
  for (let i = 0; i < 14; i += 1) {
    api.putCached(URL_, `text-${i}`, '', `<p>${i}</p>`);
  }
  api.pruneCache();
  assert.equal(api.storageKeys().filter((k) => k.startsWith('pyr.cache.')).length, 10);
  assert.equal(api.getCached(URL_, 'text-13', '', ).html, '<p>13</p>');
  assert.equal(api.getCached(URL_, 'text-0', ''), null);
});

test('clearCache removes cache keys but keeps config', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  api.storageSet('pyr.config', { model: 'x' });
  api.clearCache();
  assert.deepEqual(api.storageKeys(), ['pyr.config']);
});

test('cache is separated by pyramid language', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>', 'ru');
  assert.equal(api.getCached(URL_, TEXT, '', 'en'), null);
  assert.equal(api.getCached(URL_, TEXT, '', 'ru').html, '<h3>x</h3>');
  assert.notEqual(api.cacheKey(URL_, TEXT, '', 'ru'), api.cacheKey(URL_, TEXT, '', 'en'));
});
