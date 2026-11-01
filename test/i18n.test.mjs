import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const q = (h, sel) => h.api.__root.querySelector(sel);

function panel(language) {
  const h = loadUserscript({ store: { 'pyr.config': { language } } });
  h.api.init();
  h.api.openPanel();
  return h;
}

test('the default interface is Russian', () => {
  const h = panel('auto');
  assert.equal(q(h, '.pyr-title').textContent, 'Пирамида знаний');
  assert.equal(q(h, 'button[data-action="rebuild"]').getAttribute('aria-label'), 'Перестроить пирамиду');
  assert.equal(q(h, 'button[data-action="close"]').getAttribute('aria-label'), 'Закрыть');
  assert.match(q(h, '#pyr-focus').placeholder, /фокус/);
});

test('choosing English translates the whole panel chrome', () => {
  const h = panel('en');
  assert.equal(q(h, '.pyr-title').textContent, 'Knowledge Pyramid');
  assert.equal(q(h, '.panel').getAttribute('aria-label'), 'Knowledge Pyramid');
  assert.equal(q(h, 'button[data-action="rebuild"]').getAttribute('aria-label'), 'Rebuild pyramid');
  assert.equal(q(h, 'button[data-action="close"]').getAttribute('aria-label'), 'Close');
  assert.equal(q(h, 'button[data-action="settings"]').getAttribute('aria-label'), 'Settings');
  assert.equal(q(h, 'button[data-action="wide"]').getAttribute('aria-label'), 'Expand to full screen');
  assert.match(q(h, '#pyr-focus').placeholder, /focus/i);
  assert.equal(q(h, '#pyr-sent summary').textContent, 'show the text that was sent');
  assert.equal(q(h, 'button[data-export="md"]').getAttribute('title'), 'Download Markdown');
});

test('state badges follow the interface language', () => {
  const h = panel('en');
  h.api.setPanelState('thinking', { seconds: 4 });
  assert.match(q(h, '#pyr-state').textContent, /thinking/i);

  h.api.setPanelState('done');
  assert.equal(q(h, '#pyr-state').textContent, 'done');
});

test('cancel button and error card are translated', () => {
  const h = panel('en');
  h.api.setPanelState('requesting', { seconds: 2 });
  assert.equal(q(h, 'button[data-action="cancel"]').textContent, 'Cancel');

  h.api.showError('boom', { settings: true });
  assert.equal(q(h, '#pyr-content button[data-action="settings"]').textContent, 'Settings');
});

test('footer counters are translated', () => {
  const h = panel('en');
  h.api.setFooter({ sent: 10, total: 20, responseChars: 30, model: 'm', tokens: 40 });
  const text = q(h, '#pyr-footer-text').textContent;
  assert.match(text, /sent 10 of 20 characters/);
  assert.match(text, /answer: 30 characters/);
  assert.match(text, /tokens: 40/);
});

test('notes are translated', () => {
  const h = panel('en');
  h.api.setPanelNote('This does not look like an article — the text is short.');
  assert.match(q(h, '#pyr-note').textContent, /not look like an article/);
});

test('switching the language applies without a reload', () => {
  const h = panel('auto');
  assert.equal(q(h, '.pyr-title').textContent, 'Пирамида знаний');

  h.api.applyUiLanguage(h.api.saveConfig({ language: 'en' }));
  assert.equal(q(h, '.pyr-title').textContent, 'Knowledge Pyramid');
});

test('settings dialog is translated and still saves', () => {
  const h = panel('en');
  h.api.openSettings();
  const dlg = h.api.__root.querySelector('#pyr-settings');

  assert.equal(dlg.querySelector('h2').textContent, 'Settings');
  assert.match(dlg.querySelector('button[data-action="save"]').textContent, /Save/);

  dlg.querySelector('select[name="language"]').value = 'ru';
  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().language, 'ru');
});

test('the api key field does not invite the password manager', () => {
  const h = panel('ru');
  h.api.openSettings();
  const input = h.api.__root.querySelector('#pyr-settings input[name="apiKey"]');

  assert.equal(input.type, 'password');
  assert.equal(input.getAttribute('autocomplete'), 'new-password');
  assert.equal(input.getAttribute('data-1p-ignore'), 'true');
  assert.equal(input.getAttribute('data-lpignore'), 'true');
});
