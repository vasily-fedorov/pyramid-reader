import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REPO = 'https://github.com/vasily-fedorov/pyramid-reader';
const RAW = 'https://raw.githubusercontent.com/vasily-fedorov/pyramid-reader/main/pyramid.user.js';

const script = fs.readFileSync(new URL('../pyramid.user.js', import.meta.url), 'utf8');
const header = script.slice(0, script.indexOf('==/UserScript=='));
const field = (name) => {
  const match = header.match(new RegExp('^// @' + name + '\\s+(.+)$', 'm'));
  return match ? match[1].trim() : null;
};
const all = (name) =>
  Array.from(header.matchAll(new RegExp('^// @' + name + '\\s+(.+)$', 'gm'))).map((m) => m[1].trim());

test('namespace points at the project repository, not the manager', () => {
  assert.equal(field('namespace'), REPO);
});

test('homepage, support, update and download URLs are set', () => {
  assert.equal(field('homepageURL'), REPO);
  assert.equal(field('supportURL'), REPO + '/issues');
  assert.equal(field('updateURL'), RAW);
  assert.equal(field('downloadURL'), RAW);
});

test('update URL is reachable by name as a userscript', () => {
  assert.match(field('updateURL'), /\/pyramid\.user\.js$/);
  assert.match(field('downloadURL'), /\/pyramid\.user\.js$/);
});

test('matches every http and https page and nothing narrower', () => {
  assert.deepEqual(all('match'), ['http://*/*', 'https://*/*']);
});

test('grants cover storage, menu and cross-origin requests', () => {
  const grants = all('grant');
  for (const needed of [
    'GM_xmlhttpRequest',
    'GM_setValue',
    'GM_getValue',
    'GM_listValues',
    'GM_deleteValue',
    'GM_registerMenuCommand',
  ]) {
    assert.ok(grants.includes(needed), 'missing grant ' + needed);
  }
  assert.equal(field('connect'), '*');
});

test('the script declares a version and runs after the page is idle', () => {
  assert.match(field('version'), /^\d+\.\d+\.\d+$/);
  assert.equal(field('run-at'), 'document-idle');
});

test('the script stays out of iframes', () => {
  assert.ok(header.includes('// @noframes'), 'missing @noframes');
});

test('no reference to the old repository name remains', () => {
  assert.doesNotMatch(script, /websum/);
});
