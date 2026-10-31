import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('inlined Readability matches the vendored file byte for byte', () => {
  const vendor = fs.readFileSync(new URL('../vendor/Readability.js', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../pyramid.user.js', import.meta.url), 'utf8');
  const m = script.match(/\/\/ >>> BEGIN READABILITY[\s\S]*?\n([\s\S]*?)\n\/\/ <<< END READABILITY/);
  assert.ok(m, 'markers not found');
  assert.equal(m[1], vendor.trimEnd());
});
