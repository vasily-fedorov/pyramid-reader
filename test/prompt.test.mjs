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

test('pyramid language follows the article language', () => {
  assert.match(build(''), /языке статьи/);
  assert.doesNotMatch(build(''), /на русском языке/);
});

test('base prompt keeps the required structure headings', () => {
  const p = build('');
  assert.match(p, /<h3>📌 Executive Summary<\/h3>/);
  assert.match(p, /<h3>📐 Тезисы<\/h3>/);
  assert.doesNotMatch(p, /Многоуровневые/);
  assert.match(p, /Уровень 2/);
  assert.match(p, /Уровень 3/);
  assert.match(p, /Уровень 4/);
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

test('auto language keeps the language-of-the-article instruction', () => {
  const p = loadUserscript().api.buildSystemPrompt('', 'auto');
  assert.match(p, /на языке статьи/);
  assert.doesNotMatch(p, /на русском языке/);
  assert.doesNotMatch(p, /на английском языке/);
});

test('russian language is requested explicitly', () => {
  const p = loadUserscript().api.buildSystemPrompt('', 'ru');
  assert.match(p, /на русском языке/);
  assert.doesNotMatch(p, /на языке статьи/);
});

test('english language is requested explicitly', () => {
  const p = loadUserscript().api.buildSystemPrompt('', 'en');
  assert.match(p, /на английском языке/);
  assert.doesNotMatch(p, /на языке статьи/);
});

test('an explicit language overrides the focus tail sentence too', () => {
  assert.match(loadUserscript().api.buildSystemPrompt('архитектура', 'ru'), /Язык ответа — русский\./);
  assert.match(loadUserscript().api.buildSystemPrompt('architecture', 'en'), /Язык ответа — английский\./);
  assert.match(loadUserscript().api.buildSystemPrompt('архитектура', 'auto'), /Язык ответа — язык статьи\./);
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
