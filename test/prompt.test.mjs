import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const build = (focus) => loadUserscript().api.buildSystemPrompt(focus);

test('empty focus produces the base prompt without a focus block', () => {
  const p = build('');
  assert.doesNotMatch(p, /предмета интереса пользователя/);
});

test('whitespace-only focus is treated as empty', () => {
  assert.doesNotMatch(build('   \n\t '), /предмета интереса пользователя/);
});

test('default prompts Russian content and Russian headings', () => {
  const p = build('');
  assert.match(p, /на русском языке/);
  assert.match(p, /<h3>📌 Резюме<\/h3>/);
  assert.match(p, /<h3>📐 Тезисы<\/h3>/);
});

test('headings never mix languages', () => {
  const ru = loadUserscript().api.buildSystemPrompt('', 'ru');
  const en = loadUserscript().api.buildSystemPrompt('', 'en');

  assert.match(ru, /Резюме/);
  assert.doesNotMatch(ru, /Executive Summary/);
  assert.doesNotMatch(ru, /Theses/);

  assert.match(en, /Executive Summary/);
  assert.match(en, /Theses/);
  assert.doesNotMatch(en, /Резюме/);
  assert.doesNotMatch(en, /Тезисы/);
});

test('detectLang reads Cyrillic versus Latin prose', () => {
  const { api } = loadUserscript();
  assert.equal(api.detectLang('Цикл событий позволяет выполнять неблокирующий код.'), 'ru');
  assert.equal(api.detectLang('The event loop lets JavaScript run non-blocking code.'), 'en');
  assert.equal(api.detectLang(''), 'auto');
  assert.equal(api.detectLang('123 !!! ---'), 'auto');
});

test('base prompt keeps the required structure', () => {
  const p = build('');
  assert.match(p, /<details>/);
  assert.match(p, /<summary>/);
  assert.match(p, /<ul>/);
  assert.doesNotMatch(p, /Многоуровневые/);
});

test('rules forbid attributes and inline styles', () => {
  assert.match(build(''), /Не используй атрибуты style, class, id, href, src/);
});

test('non-empty focus is embedded verbatim and trimmed', () => {
  const p = build('  выдели примеры кода на Go  ');
  assert.match(p, /строго относительно следующего предмета интереса пользователя: выдели примеры кода на Go/);
  assert.doesNotMatch(p, / {3}выдели/);
});

test('focus with quotes and angle brackets is passed as data', () => {
  const p = build('"архитектура" <b>и</b> API');
  assert.match(p, /предмета интереса пользователя: "архитектура" <b>и<\/b> API/);
});

test('focus block warns against inventing missing material', () => {
  assert.match(build('только архитектура'), /не выдумывай факты/);
});

test('buildUserMessage wraps the article text', () => {
  const u = loadUserscript().api.buildUserMessage('Body here.');
  assert.equal(u, 'Статья:\n\nBody here.');
});

test('old heading text from cached pyramids is normalised on render', () => {
  const a = loadUserscript().api;
  const legacy = '<h3>📐 Многоуровневые Тезисы</h3><details><summary>x</summary><p>y</p></details>';
  const out = a.normalizePyramidLabels(legacy);
  assert.match(out, /<h3>📐 Тезисы<\/h3>/);
  assert.doesNotMatch(out, /Многоуровневые/);
});

test('normalisation leaves other headings alone', () => {
  const a = loadUserscript().api;
  const keep = '<h3>📌 Executive Summary</h3><h4>Подробности</h4>';
  assert.equal(a.normalizePyramidLabels(keep), keep);
});

test('prompt asks for a verbatim data-src citation on every thesis and fact', () => {
  const p = build('');
  assert.match(p, /data-src/);
  assert.match(p, /дословн/i);
  assert.match(p, /5-12 слов/);
});

test('auto resolves to the request-time language, Russian when called directly', () => {
  const p = loadUserscript().api.buildSystemPrompt('', 'auto');
  assert.match(p, /на русском языке/);
  assert.match(p, /Резюме/);
});

test('russian language is requested explicitly', () => {
  const p = loadUserscript().api.buildSystemPrompt('', 'ru');
  assert.match(p, /на русском языке/);
});

test('english language is requested explicitly', () => {
  const p = loadUserscript().api.buildSystemPrompt('', 'en');
  assert.match(p, /in English/);
});

test('the focus tail follows the same language as the headings', () => {
  assert.match(loadUserscript().api.buildSystemPrompt('архитектура', 'ru'), /На русском\./);
  assert.match(loadUserscript().api.buildSystemPrompt('architecture', 'en'), /In English\./);
});

test('the default language is auto', () => {
  const { api } = loadUserscript();
  assert.equal(api.DEFAULT_CONFIG.language, 'auto');
  assert.equal(api.loadConfig().language, 'auto');
});

test('an unknown stored language falls back to auto', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': { language: 'klingon' } } });
  assert.equal(api.loadConfig().language, 'auto');
});
