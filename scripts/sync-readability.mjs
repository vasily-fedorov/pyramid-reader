import fs from 'node:fs';

const VENDOR = new URL('../vendor/Readability.js', import.meta.url);
const SCRIPT = new URL('../pyramid.user.js', import.meta.url);

const BEGIN = '// >>> BEGIN READABILITY (vendored @mozilla/readability 0.5.0, Apache-2.0)';
const END = '// <<< END READABILITY';

const vendor = fs.readFileSync(VENDOR, 'utf8').trimEnd();
const script = fs.readFileSync(SCRIPT, 'utf8');

const beginIndex = script.indexOf(BEGIN);
const endIndex = script.indexOf(END);

if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
  throw new Error('Readability markers not found in pyramid.user.js');
}

const head = script.slice(0, beginIndex + BEGIN.length);
const tail = script.slice(endIndex);
const next = head + '\n' + vendor + '\n' + tail;

if (next !== script) {
  fs.writeFileSync(SCRIPT, next);
  process.stdout.write('Readability inlined\n');
} else {
  process.stdout.write('Readability already in sync\n');
}
