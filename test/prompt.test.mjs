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
  assert.match(p, /<h3>📐 Многоуровневые Тезисы<\/h3>/);
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
