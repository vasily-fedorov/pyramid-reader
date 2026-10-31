import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const host = (h) => h.document.getElementById('ai-pyramid-host');
const q = (h, sel) => h.window.__pyramid.__root.querySelector(sel);

test('openPanel mounts a shadow host and closePanel hides it', () => {
  const h = loadUserscript();
  h.api.openPanel();
  const el = host(h);
  assert.ok(el);
  assert.equal(h.api.__root.querySelector('.panel') !== null, true);
  assert.equal(el.shadowRoot, null);
  assert.equal(h.api.isPanelOpen(), true);
  h.api.closePanel();
  assert.equal(h.api.isPanelOpen(), false);
  assert.equal(host(h).getAttribute('hidden'), '');
});

test('host id and stacking order match the spec', () => {
  const h = loadUserscript();
  h.api.openPanel();
  const el = host(h);
  assert.equal(el.id, 'ai-pyramid-host');
  assert.match(el.style.zIndex || getComputedStyle(el).zIndex, /2147483646/);
});

test('setPanelHtml replaces content only and keeps the focus input value', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setFocusValue('только архитектура');
  h.api.setPanelHtml('<p>one</p>');
  h.api.setPanelHtml('<p>two</p>');
  assert.equal(q(h, '#pyr-content').innerHTML, '<p>two</p>');
  assert.equal(h.api.getFocusValue(), 'только архитектура');
});

test('focus input keeps its value across state changes', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setFocusValue('go examples');
  h.api.setPanelState('streaming');
  h.api.setPanelState('done');
  assert.equal(h.api.getFocusValue(), 'go examples');
});

test('requesting state shows a cancel button', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setPanelState('requesting', { seconds: 3 });
  const cancel = q(h, 'button[data-action="cancel"]');
  assert.ok(cancel);
  assert.equal(cancel.hidden, false);
});

test('rebuild button and Enter both call the rebuild handler', () => {
  const h = loadUserscript();
  h.api.openPanel();
  let calls = 0;
  h.api.onRebuild(() => {
    calls += 1;
  });
  q(h, 'button[data-action="rebuild"]').click();
  const input = q(h, '#pyr-focus');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(calls, 2);
});

test('showError renders the message and a settings button inside the content', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.showError('Неверный ключ API', { settings: true });
  assert.match(q(h, '#pyr-content').textContent, /Неверный ключ API/);
  assert.ok(q(h, '#pyr-content button[data-action="settings"]'));
});

test('setFooter exposes sent and total character counts', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setFooter({ sent: 1000, total: 2500, responseChars: 400, model: 'deepseek-flash', tokens: null });
  const text = q(h, '#pyr-footer').textContent;
  assert.match(text, /1000/);
  assert.match(text, /2500/);
  assert.match(text, /deepseek-flash/);
  assert.doesNotMatch(text, /токен/);
});

test('setFooter shows tokens only when the server reported them', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setFooter({ sent: 1000, total: 1000, responseChars: 400, model: 'deepseek-flash', tokens: 412 });
  assert.match(q(h, '#pyr-footer').textContent, /412/);
});

test('thinking state shows a waiting badge, not an empty panel', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setPanelState('thinking', { seconds: 7 });
  const badge = q(h, '#pyr-state').textContent;
  assert.match(badge, /думает/i);
  assert.match(badge, /7/);
});

test('note survives a state change', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setPanelNote('Похоже, это не статья — текст короткий.');
  h.api.setPanelState('done');
  assert.match(q(h, '#pyr-note').textContent, /не статья/);
});

test('sent text preview is collapsible and keeps the exact text', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setSentTextPreview('Use <details> for disclosure.');
  const box = q(h, '#pyr-sent');
  assert.equal(box.tagName.toLowerCase(), 'details');
  assert.match(box.textContent, /Use <details> for disclosure\./);
});

test('Esc closes the panel', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.api.isPanelOpen(), false);
});

test('panel is a labelled dialog and focuses the input on open', () => {
  const h = loadUserscript();
  h.api.openPanel();
  const panel = q(h, '.panel');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-label'), 'Пирамида знаний');
  assert.equal(h.window.__pyramid.__root.activeElement, q(h, '#pyr-focus'));
});

test('setPanelHtml keeps open details across a re-render', () => {
  const h = loadUserscript();
  h.api.openPanel();
  const markup = '<details><summary>a</summary><p>1</p></details><details><summary>b</summary><p>2</p></details>';
  h.api.setPanelHtml(markup);
  q(h, '#pyr-content').querySelectorAll('details')[1].open = true;
  h.api.setPanelHtml(markup);
  const after = q(h, '#pyr-content').querySelectorAll('details');
  assert.equal(after[1].open, true);
  assert.equal(after[0].open, false);
});

test('setPanelHtml restores scroll position after replacing content', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.setPanelHtml('<p>tall</p>');
  const content = q(h, '#pyr-content');
  content.scrollTop = 240;

  const proto = h.window.Element.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  Object.defineProperty(content, 'innerHTML', {
    configurable: true,
    get() {
      return descriptor.get.call(content);
    },
    set(value) {
      descriptor.set.call(content, value);
      content.scrollTop = 0;
    },
  });

  h.api.setPanelHtml('<p>taller</p>');
  assert.equal(content.scrollTop, 240);
  delete content.innerHTML;
});
