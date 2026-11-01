import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

function press(h, init, target) {
  const node = target || h.document;
  node.dispatchEvent(
    new h.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init }),
  );
}

const altP = { key: 'p', code: 'KeyP', altKey: true };
const altM = { key: 'm', code: 'KeyM', altKey: true };
const altQ = { key: 'q', code: 'KeyQ', altKey: true };

test('default hotkeys are Alt+P, Alt+M and Alt+Q', () => {
  const { api } = loadUserscript();
  const hotkeys = api.loadConfig().hotkeys;
  assert.equal(hotkeys.toggle, 'Alt+P');
  assert.equal(hotkeys.wide, 'Alt+M');
  assert.equal(hotkeys.focus, 'Alt+Q');
});

test('combo names normalise modifiers, letter case and digits', () => {
  const { api } = loadUserscript();
  const mk = (init) => new (loadUserscript().window.KeyboardEvent)('keydown', init);

  assert.equal(api.eventToCombo(mk({ code: 'KeyP', altKey: true })), 'Alt+P');
  assert.equal(api.eventToCombo(mk({ code: 'KeyP', ctrlKey: true, altKey: true })), 'Ctrl+Alt+P');
  assert.equal(
    api.eventToCombo(mk({ code: 'KeyK', metaKey: true, shiftKey: true, ctrlKey: true })),
    'Ctrl+Shift+Meta+K',
  );
  assert.equal(api.eventToCombo(mk({ code: 'Digit1', ctrlKey: true })), 'Ctrl+1');
  assert.equal(api.eventToCombo(mk({ code: 'F5' })), 'F5');
  assert.equal(api.eventToCombo(mk({ code: 'Escape' })), 'Escape');
});

test('a bare letter is not a usable hotkey', () => {
  const { api } = loadUserscript();
  assert.equal(api.isUsableCombo('P'), false);
  assert.equal(api.isUsableCombo('Shift+P'), false);
  assert.equal(api.isUsableCombo('Alt+P'), true);
  assert.equal(api.isUsableCombo('F5'), true);
  assert.equal(api.isUsableCombo(''), false);
});

test('invalid stored hotkeys fall back to the defaults', () => {
  const { api } = loadUserscript({
    store: { 'pyr.config': { hotkeys: { toggle: 'P', wide: 'Alt', focus: 42 } } },
  });
  const hotkeys = api.loadConfig().hotkeys;
  assert.equal(hotkeys.toggle, 'Alt+P');
  assert.equal(hotkeys.wide, 'Alt+M');
  assert.equal(hotkeys.focus, 'Alt+Q');
});

test('Alt+P opens the panel and hides it again', () => {
  const h = loadUserscript();
  h.api.init();

  press(h, altP);
  assert.equal(h.api.isPanelOpen(), true);

  press(h, altP);
  assert.equal(h.api.isPanelOpen(), false);
});

test('Alt+P works while the cursor is inside our own focus field', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openPanel();
  const input = h.window.__pyramid.__root.querySelector('#pyr-focus');
  input.focus();

  press(h, altP, input);
  assert.equal(h.api.isPanelOpen(), false);
});

test('Alt+P is not stolen from a text field on the page', () => {
  const h = loadUserscript({ html: '<!doctype html><html><body><textarea id="t"></textarea></body></html>' });
  h.api.init();
  const textarea = h.document.getElementById('t');
  textarea.focus();

  press(h, altP, textarea);
  assert.equal(h.api.isPanelOpen(), false);
});

test('Alt+M toggles the wide state and opens the panel first', () => {
  const h = loadUserscript();
  h.api.init();

  press(h, altM);
  assert.equal(h.api.isPanelOpen(), true);
  const panel = h.window.__pyramid.__root.querySelector('.panel');
  assert.equal(panel.hasAttribute('data-wide'), true);

  press(h, altM);
  assert.equal(panel.hasAttribute('data-wide'), false);
});

test('Alt+Q opens the panel and puts the cursor in the question field', () => {
  const h = loadUserscript();
  h.api.init();

  press(h, altQ);
  assert.equal(h.api.isPanelOpen(), true);
  const input = h.window.__pyramid.__root.querySelector('#pyr-focus');
  assert.equal(h.window.__pyramid.__root.activeElement, input);
});

test('the old Ctrl+Shift+P no longer does anything', () => {
  const h = loadUserscript();
  h.api.init();
  press(h, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true });
  assert.equal(h.api.isPanelOpen(), false);
});

test('a custom combination replaces the default', () => {
  const h = loadUserscript({ store: { 'pyr.config': { hotkeys: { toggle: 'Ctrl+Alt+K', wide: 'Alt+M', focus: 'Alt+Q' } } } });
  h.api.init();

  press(h, { key: 'p', code: 'KeyP', altKey: true });
  assert.equal(h.api.isPanelOpen(), false);

  press(h, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
  assert.equal(h.api.isPanelOpen(), true);
});

test('reserved browser combinations are flagged but accepted', () => {
  const { api } = loadUserscript();
  assert.equal(api.isReservedCombo('Ctrl+P'), true);
  assert.equal(api.isReservedCombo('Ctrl+Shift+P'), true);
  assert.equal(api.isReservedCombo('F12'), true);
  assert.equal(api.isReservedCombo('Alt+P'), false);
});

test('hotkeys survive a config save round trip', () => {
  const { api } = loadUserscript();
  api.saveConfig({ hotkeys: { toggle: 'Ctrl+Alt+O', wide: 'Alt+M', focus: 'Alt+Q' } });
  assert.equal(api.loadConfig().hotkeys.toggle, 'Ctrl+Alt+O');
});

test('the settings dialog shows the current combinations', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = h.window.__pyramid.__root.querySelector('#pyr-settings');

  assert.equal(dlg.querySelector('[data-hotkey="toggle"]').textContent, 'Alt+P');
  assert.equal(dlg.querySelector('[data-hotkey="wide"]').textContent, 'Alt+M');
  assert.equal(dlg.querySelector('[data-hotkey="focus"]').textContent, 'Alt+Q');
});

test('recording a new combination in the dialog saves it', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const root = h.window.__pyramid.__root;
  const dlg = root.querySelector('#pyr-settings');

  const button = dlg.querySelector('[data-hotkey="toggle"]');
  button.click();
  assert.match(button.textContent, /нажмите/i);

  button.dispatchEvent(
    new h.window.KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );

  assert.equal(button.textContent, 'Ctrl+Alt+K');
  assert.equal(h.api.loadConfig().hotkeys.toggle, 'Alt+P', 'recording alone must not persist');

  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().hotkeys.toggle, 'Ctrl+Alt+K');

  h.api.closePanel();
  press(h, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
  assert.equal(h.api.isPanelOpen(), true, 'the new combination works without a reload');
});

test('while recording, a combination does not trigger its action', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openPanel();
  const dlg = h.api.__root.querySelector('#pyr-settings') || (h.api.openSettings(), h.api.__root.querySelector('#pyr-settings'));

  dlg.querySelector('[data-hotkey="wide"]').click();
  press(h, altP);
  assert.equal(h.api.isPanelOpen(), true, 'panel must stay open while recording');
  const panel = h.api.__root.querySelector('.panel');
  assert.equal(panel.hasAttribute('data-wide'), false);
});

test('Escape cancels recording instead of closing the panel', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openPanel();
  h.api.openSettings();
  const dlg = h.api.__root.querySelector('#pyr-settings');
  const button = dlg.querySelector('[data-hotkey="toggle"]');
  const before = button.textContent;

  button.click();
  button.dispatchEvent(
    new h.window.KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );

  assert.equal(button.textContent, before);
  assert.equal(h.api.isPanelOpen(), true);
});

test('a combination without modifiers is refused with a hint', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const dlg = h.api.__root.querySelector('#pyr-settings');
  const button = dlg.querySelector('[data-hotkey="toggle"]');

  button.click();
  button.dispatchEvent(
    new h.window.KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true, cancelable: true, composed: true }),
  );

  assert.equal(button.textContent, 'нид модификатор'.replace('нид', 'нужен'));
  assert.equal(h.api.loadConfig().hotkeys.toggle, 'Alt+P');
});

test('a reserved combination warns but is accepted', () => {
  const h = loadUserscript();
  h.api.init();
  h.api.openSettings();
  const root = h.api.__root;
  const dlg = root.querySelector('#pyr-settings');
  const button = dlg.querySelector('[data-hotkey="toggle"]');

  button.click();
  button.dispatchEvent(
    new h.window.KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, cancelable: true, composed: true }),
  );

  assert.equal(button.textContent, 'Ctrl+P');
  assert.match(root.querySelector('#pyr-hotkey-warning').textContent, /браузер/i);

  dlg.querySelector('button[data-action="save"]').click();
  assert.equal(h.api.loadConfig().hotkeys.toggle, 'Ctrl+P');
});

test('reset restores the defaults', () => {
  const h = loadUserscript({ store: { 'pyr.config': { hotkeys: { toggle: 'Ctrl+Alt+K', wide: 'Alt+M', focus: 'Alt+Q' } } } });
  h.api.init();
  h.api.openSettings();
  const root = h.api.__root;
  const dlg = root.querySelector('#pyr-settings');

  dlg.querySelector('button[data-action="resetHotkeys"]').click();
  dlg.querySelector('button[data-action="save"]').click();

  const hotkeys = h.api.loadConfig().hotkeys;
  assert.equal(hotkeys.toggle, 'Alt+P');
  assert.equal(hotkeys.wide, 'Alt+M');
  assert.equal(hotkeys.focus, 'Alt+Q');
});
