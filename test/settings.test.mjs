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
      ctrlKey: true,
      shiftKey: true,
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
      ctrlKey: true,
      shiftKey: true,
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
        ctrlKey: true,
        shiftKey: true,
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
