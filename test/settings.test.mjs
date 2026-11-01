import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const root = (h) => h.window.__pyramid.__root;

test('init registers the three menu commands', () => {
  const h = loadUserscript();
  h.api.init();
  const names = h.menu.map((m) => m.name);
  assert.equal(names.length, 3);
  assert.ok(names.some((n) => /пирамид/i.test(n)));
  assert.ok(names.some((n) => /настрой/i.test(n)));
  assert.ok(names.some((n) => /кэш/i.test(n)));
});

test('hotkey opens the panel', () => {
  const h = loadUserscript();
  h.api.init();
  h.document.dispatchEvent(
    new h.window.KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      altKey: true,
      bubbles: true,
    }),
  );
  assert.equal(h.api.isPanelOpen(), true);
});

test('hotkey is ignored while typing in a page input', () => {
  const h = loadUserscript({ html: '<!doctype html><html><body><input id="x"></body></html>' });
  h.api.init();
  const input = h.document.getElementById('x');
  input.dispatchEvent(
    new h.window.KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      altKey: true,
      bubbles: true,
    }),
  );
  assert.equal(h.api.isPanelOpen(), false);
});

test('hotkey toggles the panel closed', () => {
  const h = loadUserscript();
  h.api.init();
  const fire = () =>
    h.document.dispatchEvent(
      new h.window.KeyboardEvent('keydown', {
        key: 'p',
        code: 'KeyP',
        altKey: true,
        bubbles: true,
      }),
    );
  fire();
  fire();
  assert.equal(h.api.isPanelOpen(), false);
});

test('settings dialog saves the api key without writing it into the page DOM', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');
  const keyInput = dlg.querySelector('input[name="apiKey"]');
  assert.equal(keyInput.type, 'password');
  keyInput.value = 'sk-secret';
  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().apiKey, 'sk-secret');
  assert.doesNotMatch(h.document.documentElement.outerHTML, /sk-secret/);
});

test('presets fill apiBase and model', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');

  dlg.querySelector('button[data-preset="ollama"]').click();
  assert.equal(dlg.querySelector('input[name="apiBase"]').value, 'http://localhost:11434/v1');
  assert.equal(dlg.querySelector('input[name="model"]').value, 'llama3.1');

  dlg.querySelector('button[data-preset="openai"]').click();
  assert.equal(dlg.querySelector('input[name="apiBase"]').value, 'https://api.openai.com/v1');

  dlg.querySelector('button[data-preset="deepseek"]').click();
  assert.equal(dlg.querySelector('input[name="apiBase"]').value, 'https://api.deepseek.com');
  assert.equal(dlg.querySelector('input[name="model"]').value, 'deepseek-flash');
});

test('default dialog values are DeepSeek', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');
  assert.equal(dlg.querySelector('input[name="apiBase"]').value, 'https://api.deepseek.com');
  assert.equal(dlg.querySelector('input[name="model"]').value, 'deepseek-flash');
});

test('clearing the cache removes only cache entries', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.putCached('https://example.com/a', 't', '', '<p>x</p>');
  const clear = h.menu.find((m) => /кэш/i.test(m.name));
  clear.fn();
  assert.equal(h.api.storageKeys().filter((k) => k.startsWith('pyr.cache.')).length, 0);
});

test('closed shadow root hides panel internals from page scripts', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openPanel();
  const el = h.document.getElementById('ai-pyramid-host');
  assert.equal(el.shadowRoot, null);
  assert.ok(h.api.__root);
});

test('stored api key is not prefilled into the dialog', () => {
  const h = loadUserscript({ store: { 'pyr.config': { apiKey: 'sk-stored' } } });
  h.api.init();
  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');
  const input = dlg.querySelector('input[name="apiKey"]');
  assert.equal(input.value, '');
  assert.equal(input.type, 'password');
  assert.doesNotMatch(h.document.documentElement.outerHTML, /sk-stored/);
});

test('saving an empty key field keeps the stored key, clear button erases it', () => {
  const h = loadUserscript({ store: { 'pyr.config': { apiKey: 'sk-stored' } } });
  h.api.init();
  h.api.openSettings();
  root(h).querySelector('#pyr-settings button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().apiKey, 'sk-stored');

  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');
  dlg.querySelector('input[name="apiKey"]').value = 'sk-new';
  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().apiKey, 'sk-new');

  h.api.openSettings();
  root(h).querySelector('#pyr-settings button[data-action="clearKey"]').click();
  assert.equal(h.api.loadConfig().apiKey, '');
});

test('menu settings command opens the panel', () => {
  const h = loadUserscript();
  h.api.init();
  const settings = h.menu.find((m) => /настрой/i.test(m.name));
  settings.fn();
  assert.equal(h.api.isPanelOpen(), true);
});

test('untrusted hotkey events are ignored', () => {
  const h = loadUserscript();
  h.api.init();
  h.window.__PYRAMID_TEST_HOOK__ = false;
  h.document.dispatchEvent(
    new h.window.KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    }),
  );
  assert.equal(h.api.isPanelOpen(), false);
  h.window.__PYRAMID_TEST_HOOK__ = true;
});

test('settings expose the thinking toggle and persist it', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');
  const box = dlg.querySelector('input[name="thinking"]');
  assert.ok(box);
  assert.equal(box.checked, false);

  box.checked = true;
  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().thinking, true);
});

test('settings offer the three pyramid languages and save the choice', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = root(h).querySelector('#pyr-settings');
  const select = dlg.querySelector('select[name="language"]');

  assert.ok(select);
  assert.deepEqual(
    Array.from(select.options).map((option) => option.value),
    ['auto', 'ru', 'en'],
  );
  assert.equal(select.value, 'auto');

  select.value = 'en';
  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().language, 'en');
});
