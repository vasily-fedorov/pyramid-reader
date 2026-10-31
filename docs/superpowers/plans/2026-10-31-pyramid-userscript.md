# AI Multi-level Artifact Pyramid Reader — план реализации

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ СУБ-СКИЛЛ: используйте
> `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`, чтобы выполнять план задача за задачей.
> Шаги размечены чекбоксами (`- [ ]`).

**Цель:** юзерскрипт Tampermonkey/Violentmonkey, который по `Ctrl+Shift+P`
строит в боковой панели многоуровневую пирамиду тезисов по тексту любой
открытой статьи, с необязательным полем фокуса и стримингом ответа.

**Архитектура:** один устанавливаемый файл `pyramid.user.js`, внутри — IIFE с
секциями (конфиг → хранилище → Readability → экстрактор → санитайзер → промпт
→ кэш → API → панель → настройки → рендер → триггеры). Панель живёт в open
shadow root, сеть — только через `GM_xmlhttpRequest`. В конце файла — тестовый
хук `window.__pyramid`, который включается только когда выставлен
`globalThis.__PYRAMID_TEST_HOOK__`, поэтому продакшн-путь инициализации не
затрагивается.

**Стек:** чистый ES2020, без сборки и рантайм-зависимостей. Тесты — `node --test`
+ `jsdom` (devDependency). Стенд — Node ≥ 18 без зависимостей.

**Спека:** `docs/superpowers/specs/2026-10-31-pyramid-userscript-design.md`

## Глобальные ограничения

- Юзерскрипт — ровно один файл `pyramid.user.js`; никакой сборки на этапе
  установки, никаких `import`/`require` внутри него.
- Шапка `==UserScript==` дословно из спеки §7, включая `@connect *`,
  `@grant GM_listValues`, `@grant GM_deleteValue`, `@run-at document-idle`.
- Сеть — только `GM_xmlhttpRequest`. `fetch` к API не используется нигде.
- Язык интерфейса — русский. Язык пирамиды — язык статьи.
- Никакого `innerHTML` с непроверенным HTML: только через `sanitizeHtml`.
- Все атрибуты у разрешённых тегов удаляются, включая `style`, `class`, `href`,
  `src`.
- `@match` не содержит специфичных для сайта доменов — только `http://*/*` и
  `https://*/*`. Никаких селекторов под конкретный сайт в коде.
- Тексты промптов — дословно из спеки §6.3.
- Лимиты: `maxChars` 60 000, `maxTokens` 4096, TTL кэша 7 дней, 10 записей,
  96 КБ на запись, таймаут 180 с.
- Никаких `as any`-эквивалентов: не глотать ошибки пустыми `catch`, не
  подавлять исключения без возврата значения по умолчанию.

## Фокус ревью

Шесть классов ввода, которые спека подразумевает, но которые легче всего
сломать. У каждого — тест в задаче, которой принадлежит код.

1. **Статья, в тексте которой есть HTML-подобные символы** (`<details>`,
   `<script>`), должна попадать в модель как текст, а не как разметка.
2. **Ответ модели в markdown вместо HTML** (`**жирный**`, ```` ```html ````)
   должен отрендериться как текст, без обёрток и без исполнения.
3. **Страница, где Readability принимает за статью навигацию и комментарии**,
   должна либо отдать тело статьи, либо честно пометить короткий/подозрительный
   текст, а не молча отправить меню.
4. **SSE-чанк, разрывающий строку `data:` или JSON посередине**, должен
   собираться без потери и без дублей.
5. **Текст фокуса с кавычками, `<` и переводами строк** должен попадать в
   промпт как данные и не ломать структуру сообщения.
6. **Перерисовка панели во время стриминга не должна стирать введённый фокус
   и позицию скролла.**

---

## Структура файлов

```
pyramid.user.js                  единственный устанавливаемый артефакт
package.json                     devDependencies: jsdom; scripts.test
.gitignore                       node_modules/
vendor/Readability.js            @mozilla/readability 0.5.0, Apache-2.0, дословно
scripts/sync-readability.mjs     переинлайнивает vendor в pyramid.user.js
test/helpers/load-userscript.mjs поднимает юзерскрипт в jsdom с шимом GM_*
test/fixtures/*.html             по одному файлу на тип вёрстки
test/*.test.mjs                  юнит- и интеграционные тесты
test/mock-server.mjs             стенд: SSE + флаги ошибок
test/fixture.html                ручной стенд в браузере
README.md                        установка, настройка, стенд
```

`pyramid.user.js` держит все секции по порядку из спеки §7. Файл один
намеренно: это артефакт, который пользователь копирует в менеджер скриптов.

---

### Task 1: Каркас, конфиг, хранилище

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `pyramid.user.js`
- Create: `test/helpers/load-userscript.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_CONFIG: Config`, где `Config = {apiBase:string, apiKey:string, model:string, maxChars:number, maxTokens:number, temperature:number, timeoutSec:number, autoExtract:boolean}`
  - `CONFIG_KEY = 'pyr.config'`
  - `loadConfig(): Config`
  - `saveConfig(patch: Partial<Config>): Config`
  - `storageGet(key: string, fallback: any): any`
  - `storageSet(key: string, value: any): void`
  - `storageDelete(key: string): void`
  - `storageKeys(): string[]`
  - `window.__pyramid` — объект со всеми публичными именами секций
  - `loadUserscript(options): {dom, window, document, api, store, menu, requests}`

- [ ] **Step 1: Создать `package.json` и `.gitignore`**

```json
{
  "name": "pyramid-userscript",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/*.test.mjs" },
  "devDependencies": { "jsdom": "^25.0.0" }
}
```

`.gitignore`: единственная строка `node_modules/`.

- [ ] **Step 2: Установить jsdom**

Run: `npm install`
Expected: exit 0, появляется `node_modules/` и `package-lock.json`.

- [ ] **Step 3: Написать `test/helpers/load-userscript.mjs`**

Шим: `GM_*` вешаются на `window` до `eval`, хранилище — `Map`, объекты
хранятся как есть (семантика Tampermonkey, без `JSON.stringify`).

```js
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const USERSCRIPT = new URL('../../pyramid.user.js', import.meta.url);

export function loadUserscript({
  html = '<!doctype html><html><head><title>T</title></head><body></body></html>',
  url = 'https://example.com/article',
  store = {},
  gmRequest = null,
} = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'dangerously' });
  const w = dom.window;
  const storeMap = new Map(Object.entries(store));
  const menu = [];
  const requests = [];

  w.GM_getValue = (k, d) => (storeMap.has(k) ? storeMap.get(k) : d);
  w.GM_setValue = (k, v) => { storeMap.set(k, v); };
  w.GM_deleteValue = (k) => { storeMap.delete(k); };
  w.GM_listValues = () => [...storeMap.keys()];
  w.GM_registerMenuCommand = (name, fn) => menu.push({ name, fn });
  w.GM_xmlhttpRequest = (details) => {
    requests.push(details);
    return gmRequest ? gmRequest(details) : { abort() {} };
  };

  w.__PYRAMID_TEST_HOOK__ = true;
  w.eval(fs.readFileSync(USERSCRIPT, 'utf8'));

  return { dom, window: w, document: w.document, api: w.__pyramid, store: storeMap, menu, requests };
}
```

- [ ] **Step 4: Написать падающий тест `test/config.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

test('loadConfig returns defaults when storage is empty', () => {
  const { api } = loadUserscript();
  assert.deepEqual(api.loadConfig(), api.DEFAULT_CONFIG);
});

test('loadConfig merges stored values over defaults', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': { model: 'llama3' } } });
  const cfg = api.loadConfig();
  assert.equal(cfg.model, 'llama3');
  assert.equal(cfg.apiBase, api.DEFAULT_CONFIG.apiBase);
});

test('loadConfig survives corrupt stored string', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': '{not json' } });
  assert.deepEqual(api.loadConfig(), api.DEFAULT_CONFIG);
});

test('loadConfig coerces numeric strings and clamps', () => {
  const { api } = loadUserscript({ store: { 'pyr.config': { maxChars: '5000', temperature: '9' } } });
  const cfg = api.loadConfig();
  assert.equal(cfg.maxChars, 5000);
  assert.equal(cfg.temperature, 2);
});

test('saveConfig persists a patch and returns the merged config', () => {
  const { api, store } = loadUserscript();
  const cfg = api.saveConfig({ model: 'gpt-4o' });
  assert.equal(cfg.model, 'gpt-4o');
  assert.equal(store.get('pyr.config').model, 'gpt-4o');
  assert.equal(store.get('pyr.config').apiBase, api.DEFAULT_CONFIG.apiBase);
});

test('storage roundtrip, delete and keys', () => {
  const { api } = loadUserscript();
  api.storageSet('a', { x: 1 });
  assert.deepEqual(api.storageGet('a', null), { x: 1 });
  assert.equal(api.storageGet('missing', 'dflt'), 'dflt');
  assert.deepEqual(api.storageKeys(), ['a']);
  api.storageDelete('a');
  assert.deepEqual(api.storageKeys(), []);
});
```

- [ ] **Step 5: Запустить тест, убедиться что падает**

Run: `npm test`
Expected: FAIL — `ENOENT ... pyramid.user.js`.

- [ ] **Step 6: Создать `pyramid.user.js` с шапкой, хранилищем, конфигом и хуком**

Шапка — дословно из спеки §7. Внутри IIFE:

```js
const CONFIG_KEY = 'pyr.config';

const DEFAULT_CONFIG = {
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  maxChars: 60000,
  maxTokens: 4096,
  temperature: 0.3,
  timeoutSec: 180,
  autoExtract: true,
};

const NUMERIC_LIMITS = {
  maxChars: [1000, 400000],
  maxTokens: [256, 32000],
  temperature: [0, 2],
  timeoutSec: [10, 600],
};

function storageGet(key, fallback) { /* GM_getValue, иначе localStorage с JSON, ошибка → fallback */ }
function storageSet(key, value) { /* GM_setValue, иначе localStorage + JSON */ }
function storageDelete(key) { /* ... */ }
function storageKeys() { /* GM_listValues, иначе ключи localStorage */ }

function coerceConfig(raw) { /* Object.assign({}, DEFAULT_CONFIG, raw); числа через Number + clamp; autoExtract через Boolean; строки через String */ }
function loadConfig() { /* storageGet(CONFIG_KEY, null) → если строка, JSON.parse с try/catch → coerceConfig */ }
function saveConfig(patch) { /* merge + storageSet + return */ }

function init() { /* пусто до Task 10 */ }
```

В конце IIFE:

```js
if (globalThis.__PYRAMID_TEST_HOOK__) {
  globalThis.__pyramid = { DEFAULT_CONFIG, CONFIG_KEY, loadConfig, saveConfig, storageGet, storageSet, storageDelete, storageKeys };
} else {
  init();
}
```

- [ ] **Step 7: Запустить тесты, убедиться что проходят**

Run: `npm test`
Expected: PASS, 6 тестов, 0 падений.

- [ ] **Step 8: Коммит**

```bash
git add package.json package-lock.json .gitignore pyramid.user.js test/helpers/load-userscript.mjs test/config.test.mjs
git commit -m "feat: userscript skeleton with config and GM storage"
```

---

### Task 2: Кэш

**Files:**
- Modify: `pyramid.user.js` (секция Cache до секции триггеров)
- Test: `test/cache.test.mjs`

**Interfaces:**
- Consumes: `storageGet`, `storageSet`, `storageDelete`, `storageKeys` (Task 1)
- Produces:
  - `CACHE_PREFIX = 'pyr.cache.'`, `CACHE_TTL_MS`, `CACHE_MAX_ENTRIES = 10`, `CACHE_MAX_BYTES = 98304`
  - `cacheKey(url: string, text: string, focus: string): string`
  - `getCached(url: string, text: string, focus: string): {ts:number, html:string, focus:string} | null`
  - `putCached(url: string, text: string, focus: string, html: string): void`
  - `pruneCache(): void`
  - `clearCache(): void`

- [ ] **Step 1: Написать падающий тест `test/cache.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const URL_ = 'https://example.com/a';
const TEXT = 'Article body text.';

test('cacheKey is stable for identical input and differs by focus', () => {
  const { api } = loadUserscript();
  assert.equal(api.cacheKey(URL_, TEXT, ''), api.cacheKey(URL_, TEXT, ''));
  assert.notEqual(api.cacheKey(URL_, TEXT, ''), api.cacheKey(URL_, TEXT, 'architecture'));
  assert.notEqual(api.cacheKey(URL_, TEXT, ''), api.cacheKey('https://example.com/b', TEXT, ''));
});

test('cacheKey is prefixed', () => {
  const { api } = loadUserscript();
  assert.ok(api.cacheKey(URL_, TEXT, '').startsWith('pyr.cache.'));
});

test('putCached then getCached returns the html', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  assert.equal(api.getCached(URL_, TEXT, '').html, '<h3>x</h3>');
});

test('getCached returns null for a different focus', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  assert.equal(api.getCached(URL_, TEXT, 'only code'), null);
});

test('getCached drops entries past the TTL', () => {
  const { api, store } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  const key = api.cacheKey(URL_, TEXT, '');
  store.get(key).ts = Date.now() - api.CACHE_TTL_MS - 1000;
  assert.equal(api.getCached(URL_, TEXT, ''), null);
  assert.equal(store.has(key), false);
});

test('putCached truncates html to CACHE_MAX_BYTES', () => {
  const { api } = loadUserscript();
  api.putCached(URL_, TEXT, '', 'x'.repeat(api.CACHE_MAX_BYTES + 5000));
  assert.equal(api.getCached(URL_, TEXT, '').html.length, api.CACHE_MAX_BYTES);
});

test('pruneCache keeps only the 10 newest entries', () => {
  const { api } = loadUserscript();
  for (let i = 0; i < 14; i += 1) {
    api.putCached(URL_, `text-${i}`, '', `<p>${i}</p>`);
  }
  api.pruneCache();
  assert.equal(api.storageKeys().filter((k) => k.startsWith('pyr.cache.')).length, 10);
  assert.equal(api.getCached(URL_, 'text-13', '', ).html, '<p>13</p>');
  assert.equal(api.getCached(URL_, 'text-0', ''), null);
});

test('clearCache removes cache keys but keeps config', () => {
  const { api, store } = loadUserscript();
  api.putCached(URL_, TEXT, '', '<h3>x</h3>');
  api.storageSet('pyr.config', { model: 'x' });
  api.clearCache();
  assert.deepEqual(api.storageKeys(), ['pyr.config']);
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern=cache`
Expected: FAIL — `api.cacheKey is not a function`.

- [ ] **Step 3: Реализовать секцию Cache в `pyramid.user.js`**

`cacheKey` = `CACHE_PREFIX + djb2(url + '|' + text.length + '|' + text.slice(0,64) + '|' + focus).toString(36)`, где `djb2` — классический хеш, возвращающий `>>> 0`.

`putCached` пишет `{ts: Date.now(), html: html.slice(0, CACHE_MAX_BYTES), focus}` и сразу вызывает `pruneCache()`. `ts` монотонен: `ts: Math.max(Date.now(), lastTs + 1)`, где `lastTs` — модульная переменная, обновляемая при каждой записи (иначе 14 записей в одну миллисекунду сортируются произвольно).

`getCached` читает `storageGet(key, null)`, проверяет `focus`, `ts` и `html`; при просрочке `storageDelete(key)` и `null`.

`pruneCache` берёт `storageKeys().filter(k => k.startsWith(CACHE_PREFIX))`, сортирует по `ts` убыв., при равенстве — по индексу в списке убыв., удаляет всё после 10-го.

`clearCache` удаляет все ключи с префиксом.

Добавить новые имена в объект `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, 7 новых тестов зелёные, старые тоже.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/cache.test.mjs
git commit -m "feat: per-article focus-aware cache with TTL and pruning"
```

---

### Task 3: Санитайзер

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/sanitizer.test.mjs`

**Interfaces:**
- Produces:
  - `ALLOWED_TAGS: Set<string>` — `h3 h4 h5 p ul ol li details summary strong b em i code pre blockquote br hr span div table thead tbody tr th td`
  - `DROP_TAGS: Set<string>` — `script style iframe object embed img svg link meta form input template noscript`
  - `sanitizeHtml(html: string): string`

- [ ] **Step 1: Написать падающий тест `test/sanitizer.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const s = (html) => loadUserscript().api.sanitizeHtml(html);

test('keeps allowed structure', () => {
  const out = s('<h3>T</h3><details><summary>S</summary><p>body</p></details>');
  assert.match(out, /<h3>T<\/h3>/);
  assert.match(out, /<details><summary>S<\/summary><p>body<\/p><\/details>/);
});

test('drops script with its content', () => {
  const out = s('<p>a</p><script>alert(1)</script>');
  assert.equal(out, '<p>a</p>');
});

test('drops img entirely', () => {
  assert.equal(s('<p>a<img src="x" onerror="alert(1)">b</p>'), '<p>ab</p>');
});

test('strips every attribute from allowed tags', () => {
  const out = s('<details style="margin-left:20px" open class="c"><summary id="s">x</summary></details>');
  assert.equal(out, '<details><summary>x</summary></details>');
});

test('unwraps unknown tags but keeps their text', () => {
  assert.equal(s('<p>a <a href="javascript:alert(1)">link</a> b</p>'), '<p>a link b</p>');
});

test('removes comments', () => {
  assert.equal(s('<p>a<!-- nasty -->b</p>'), '<p>ab</p>');
});

test('markdown left by the model stays literal text', () => {
  const out = s('<p>**bold** and `code`</p><pre>```html\nx\n```</pre>');
  assert.match(out, /\*\*bold\*\*/);
  assert.match(out, /```html/);
});

test('html-like text inside an article does not become markup', () => {
  const out = s('<p>Use &lt;details&gt; for disclosure.</p>');
  assert.equal(out, '<p>Use &lt;details&gt; for disclosure.</p>');
});

test('handles an unclosed stream fragment', () => {
  const out = s('<details><summary>x</summary><p>y');
  assert.match(out, /<details><summary>x<\/summary><p>y<\/p><\/details>/);
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern=sanitizer`
Expected: FAIL — `sanitizeHtml is not a function`.

- [ ] **Step 3: Реализовать `sanitizeHtml`**

Через `new DOMParser().parseFromString(html, 'text/html')`, рекурсивный проход
по `childNodes`: комментарии удаляются, `DROP_TAGS` удаляются с содержимым,
остальные сначала рекурсивно очищаются, затем неизвестные разворачиваются
(`insertBefore` всех детей вместо узла), разрешённые — теряют все атрибуты.
Возврат — `doc.body.innerHTML`.

Добавить имена в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/sanitizer.test.mjs
git commit -m "feat: allowlist HTML sanitizer for model output"
```

---

### Task 4: Сборка промпта

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/prompt.test.mjs`

**Interfaces:**
- Produces:
  - `BASE_PROMPT: string`, `PROMPT_RULES: string`, `FOCUS_TEMPLATE: string`
  - `buildSystemPrompt(focus: string): string`
  - `buildUserMessage(text: string): string`

- [ ] **Step 1: Написать падающий тест `test/prompt.test.mjs`**

```js
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
  assert.doesNotMatch(p, /   выдели/);
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
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern=prompt`
Expected: FAIL.

- [ ] **Step 3: Реализовать константы и функции**

`BASE_PROMPT` — дословно из спеки §6.3 (с «на языке статьи»).
`PROMPT_RULES` — дословно блок «Дополнение к system-сообщению».
`FOCUS_TEMPLATE` — дословно блок «Дополнение при непустом поле фокуса»;
подстановка — `FOCUS_TEMPLATE.replace('<текст из поля ввода>', () => focus.trim())`
(замена через функцию, иначе `$&` и `$1` в фокусе интерпретируются как
шаблон замены и текст пользователя искажается).
`buildSystemPrompt` склеивает блоки через `\n\n`, пропуская фокус-блок при
пустом `focus`. `buildUserMessage(text)` = `'Статья:\n\n' + text`.

Добавить имена в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/prompt.test.mjs
git commit -m "feat: system prompt builder with focus injection"
```

---

### Task 5: Экстрактор статьи

**Files:**
- Create: `vendor/Readability.js`
- Create: `scripts/sync-readability.mjs`
- Create: `test/fixtures/docs-with-code.html`
- Create: `test/fixtures/tech-blog.html`
- Create: `test/fixtures/news-article.html`
- Create: `test/fixtures/heavy-framework.html`
- Create: `test/fixtures/no-article.html`
- Modify: `pyramid.user.js`
- Test: `test/extract.test.mjs`
- Test: `test/readability-vendor.test.mjs`

**Interfaces:**
- Produces:
  - `MIN_ARTICLE_CHARS = 500`, `SHORT_TEXT_CHARS = 400`
  - `htmlToPlainText(root: Element): string`
  - `extractArticle(doc: Document, opts: {autoExtract?: boolean, maxChars?: number}): {text: string, originalLength: number, truncated: boolean, short: boolean, usedReadability: boolean}`
  - Inlined Readability между маркерами
    `// >>> BEGIN READABILITY (vendored @mozilla/readability 0.5.0, Apache-2.0)`
    и `// <<< END READABILITY`

- [ ] **Step 1: Скачать вендорную библиотеку**

Run: `mkdir -p vendor && curl -sSL https://unpkg.com/@mozilla/readability@0.5.0/Readability.js -o vendor/Readability.js && wc -l vendor/Readability.js`
Expected: ~2314 строк, первая строка — `/*` и копирайт Arc90, последние строки — `module.exports = Readability;`.

- [ ] **Step 2: Написать `scripts/sync-readability.mjs`**

Скрипт читает `vendor/Readability.js` и `pyramid.user.js`, заменяет всё между
маркерами на содержимое вендорного файла, пишет обратно. Идемпотентен:
повторный запуск даёт побайтово тот же файл.

- [ ] **Step 3: Создать фикстуры**

Пять файлов, каждый — валидный HTML-документ. Требования:

- `docs-with-code.html` — `<nav>` со «Skip to content / Docs / API», статья
  ≥ 900 символов, внутри `<pre><code class="language-python">` с телом
  `def f():\n    return 1\n` (4 пробела отступа), и `<pre><code class="language-bash">`.
- `tech-blog.html` — `<header>`, статья ≥ 900 символов, `<aside>Related</aside>`,
  `<footer>© 2026</footer>`.
- `news-article.html` — cookie-баннер `.cookie`, форма подписки `.subscribe`,
  статья ≥ 900 символов в `<article>`.
- `heavy-framework.html` — `<div id="app">` с боковым меню из 20 ссылок,
  `<div role="main">` с текстом ≥ 900 символов.
- `no-article.html` — каталог товаров: 12 карточек, суммарный текст < 400
  символов, никакой статьи.

- [ ] **Step 4: Написать падающий тест `test/extract.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadUserscript } from './helpers/load-userscript.mjs';

const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function extract(name, opts = {}) {
  const h = loadUserscript({ html: fixture(name) });
  return h.api.extractArticle(h.document, opts);
}
```

Тесты:

```js
test('docs page: article body without site chrome', () => {
  const r = extract('docs-with-code.html');
  assert.ok(r.usedReadability);
  assert.doesNotMatch(r.text, /Skip to content/);
  assert.doesNotMatch(r.text, /Docs \/ API/);
  assert.ok(r.text.length > 500);
});

test('docs page: code fences keep language and indentation', () => {
  const r = extract('docs-with-code.html');
  assert.match(r.text, /```python\ndef f\(\):\n {4}return 1\n```/);
  assert.match(r.text, /```bash/);
});

test('tech blog: footer and aside are not in the text', () => {
  const r = extract('tech-blog.html');
  assert.doesNotMatch(r.text, /© 2026/);
  assert.doesNotMatch(r.text, /Related/);
});

test('news page: cookie banner and subscription form are dropped', () => {
  const r = extract('news-article.html');
  assert.doesNotMatch(r.text, /Accept all cookies/);
  assert.doesNotMatch(r.text, /Subscribe to our newsletter/);
});

test('heavy framework page: sidebar menu is not in the text', () => {
  const r = extract('heavy-framework.html');
  assert.doesNotMatch(r.text, /Products/);
  assert.doesNotMatch(r.text, /Pricing/);
});

test('no-article page: short flag is set', () => {
  const r = extract('no-article.html');
  assert.equal(r.short, true);
  assert.equal(r.usedReadability, false);
});

test('truncation cuts at a paragraph boundary and reports the original length', () => {
  const para = 'A'.repeat(300);
  const html = `<!doctype html><html><body><article>${`<p>${para}</p>`.repeat(10)}</article></body></html>`;
  const h = loadUserscript({ html });
  const r = h.api.extractArticle(h.document, { maxChars: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1000);
  assert.ok(r.originalLength >= 3000);
  assert.equal(r.text.endsWith('A'), true);
  assert.doesNotMatch(r.text, /\n\n+$/);
});

test('autoExtract:false skips Readability and still returns text', () => {
  const h = loadUserscript({ html: fixture('docs-with-code.html') });
  const r = h.api.extractArticle(h.document, { autoExtract: false });
  assert.equal(r.usedReadability, false);
  assert.ok(r.text.length > 0);
});
```

- [ ] **Step 5: Написать падающий тест `test/readability-vendor.test.mjs`**

```js
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
```

- [ ] **Step 6: Запустить, убедиться что тесты падают**

Run: `npm test -- --test-name-pattern="extract|Readability"`
Expected: FAIL — `extractArticle is not a function`.

- [ ] **Step 7: Реализовать `htmlToPlainText` и `extractArticle`**

`htmlToPlainText` обходит узлы: текстовые узлы схлопываются по `\s+` в один
пробел; `<pre>` превращается в `\n```{lang}\n{textContent с сохранёнными
отступами}\n```\n`, где `lang` берётся из `class="language-*"` у вложенного
`<code>` или у самого `<pre>`; `<br>` → `\n`; `<li>` → `\n- `; блочные теги
(`P DIV SECTION ARTICLE MAIN H1..H6 UL OL BLOCKQUOTE TABLE TR TD TH FIGCAPTION`)
окружаются переводами строки. В конце `replace(/\n{3,}/g, '\n\n')` и `trim()`.

`extractArticle`:
1. `opts = {autoExtract: true, maxChars: 60000, ...opts}`.
2. `const clone = doc.cloneNode(true)`; удалить из клона
   `script, style, noscript, nav, aside, footer, form, iframe, svg, canvas,
   [aria-hidden="true"], .cookie, .newsletter, .subscribe`.
3. Если `autoExtract` — `new Readability(clone).parse()` в `try/catch`;
   при `content` непустом: `container = элемент из parsed.content` (через
   `DOMParser` на `parsed.content`), `usedReadability = true`.
4. Если Readability не дала ≥ `MIN_ARTICLE_CHARS` символов текста — взять
   `article`, затем `main`, затем `[role="main"]`, затем
   `[itemprop="articleBody"]`, затем `doc.body`; `usedReadability = false`.
5. `text = htmlToPlainText(container)`.
6. `originalLength = text.length`; если больше `maxChars`, отрезать по
   последнему `\n\n` до `maxChars` (если такого нет — по `maxChars`),
   `truncated = true`.
7. `short = text.length < SHORT_TEXT_CHARS`.

Добавить имена в `__pyramid`.

- [ ] **Step 8: Вставить Readability и синхронизировать**

В Step 7 в `pyramid.user.js` уже стоят два маркера с пустым телом между ними:

```js
// >>> BEGIN READABILITY (vendored @mozilla/readability 0.5.0, Apache-2.0)
// <<< END READABILITY
```

Run: `node scripts/sync-readability.mjs`
Expected: содержимое `vendor/Readability.js` оказалось между маркерами,
`test/readability-vendor.test.mjs` зелёный, повторный запуск скрипта не
меняет файл.

- [ ] **Step 9: Запустить тесты**

Run: `npm test`
Expected: PASS. Если фикстура даёт < 500 символов и тест «article body»
падает — увеличить текст фикстуры, а не ослаблять порог.

- [ ] **Step 10: Коммит**

```bash
git add vendor/Readability.js scripts/sync-readability.mjs test/fixtures test/extract.test.mjs test/readability-vendor.test.mjs pyramid.user.js
git commit -m "feat: Readability-based extraction with code fences and truncation"
```

---

### Task 6: SSE-парсер и разбор ошибок

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/sse.test.mjs`

**Interfaces:**
- Produces:
  - `createSseParser(onPayload: (payload:any) => void): {push(chunk: string): {done: boolean}, flush(): {done: boolean}}`
  - `extractDelta(payload: any): string`
  - `extractUsage(payload: any): number | null`
  - `parseApiError(status: number, bodyText: string): string`

- [ ] **Step 1: Написать падающий тест `test/sse.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const api = () => loadUserscript().api;
const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('parses a complete single event', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  assert.equal(p.push(chunk('hello')).done, false);
  assert.equal(seen[0].choices[0].delta.content, 'hello');
});

test('reassembles an event split across chunk boundaries', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  const full = chunk('split me');
  p.push(full.slice(0, 12));
  p.push(full.slice(12, 30));
  p.push(full.slice(30));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].choices[0].delta.content, 'split me');
});

test('reports done on [DONE] and stops emitting', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  assert.equal(p.push('data: [DONE]\n\n').done, true);
  assert.equal(seen.length, 0);
});

test('ignores blank lines and comment keep-alives', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  p.push('\n\n: keep-alive\n\n');
  assert.equal(seen.length, 0);
});

test('survives a malformed json event without throwing', () => {
  const seen = [];
  const p = api().createSseParser((x) => seen.push(x));
  assert.doesNotThrow(() => p.push('data: {broken\n\n'));
  assert.equal(seen.length, 0);
});

test('extractDelta reads delta content and ignores role-only chunks', () => {
  const a = api();
  assert.equal(a.extractDelta({ choices: [{ delta: { content: 'x' } }] }), 'x');
  assert.equal(a.extractDelta({ choices: [{ delta: { role: 'assistant' } }] }), '');
  assert.equal(a.extractDelta({}), '');
});

test('extractDelta ignores reasoning_content from thinking models', () => {
  const a = api();
  assert.equal(a.extractDelta({ choices: [{ delta: { reasoning_content: 'hmm...' } }] }), '');
  assert.equal(a.extractDelta({ choices: [{ delta: { reasoning_content: 'hmm', content: 'ok' } }] }), 'ok');
});

test('extractUsage reads completion_tokens from the final chunk', () => {
  const a = api();
  assert.equal(a.extractUsage({ usage: { completion_tokens: 412, prompt_tokens: 900 } }), 412);
});

test('extractUsage returns null when the server sends no usage', () => {
  const a = api();
  assert.equal(a.extractUsage({ choices: [] }), null);
  assert.equal(a.extractUsage({}), null);
  assert.equal(a.extractUsage({ usage: { completion_tokens: 0 } }), null);
});

test('parseApiError maps auth failures', () => {
  const a = api();
  assert.match(a.parseApiError(401, '{"error":{"message":"bad key"}}'), /Неверный ключ API/);
  assert.match(a.parseApiError(403, ''), /Неверный ключ API/);
});

test('parseApiError maps quota and rate limits', () => {
  const a = api();
  assert.match(a.parseApiError(429, '{"error":{"message":"Rate limit reached"}}'), /Закончились токены|лимит/);
  assert.match(a.parseApiError(402, ''), /Закончились токены|лимит/);
  assert.match(a.parseApiError(400, '{"error":{"code":"insufficient_quota"}}'), /Закончились токены|лимит/);
});

test('parseApiError maps 404 to model or address', () => {
  assert.match(loadUserscript().api.parseApiError(404, ''), /Модель или адрес/);
});

test('parseApiError passes through a 400 server message', () => {
  const msg = loadUserscript().api.parseApiError(400, '{"error":{"message":"model not supported"}}');
  assert.match(msg, /model not supported/);
});

test('parseApiError maps status 0 to a network hint', () => {
  assert.match(loadUserscript().api.parseApiError(0, ''), /Не удалось связаться с API/);
});

test('parseApiError never returns raw json', () => {
  const msg = loadUserscript().api.parseApiError(500, '{"error":{"message":"boom"},"x":1}');
  assert.doesNotMatch(msg, /"x":1/);
  assert.match(msg, /boom/);
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern="sse|parseApiError"`
Expected: FAIL.

- [ ] **Step 3: Реализовать**

`createSseParser` держит `buf`; на `push` дописывает chunk, режет по `\n`,
для каждой строки: пустая — пропуск, `:` в начале — комментарий/keep-alive,
`data: ` — снять префикс, `[DONE]` → `done`, иначе `JSON.parse` в `try/catch`
и `onPayload`. Возвращает `{done}`.

`extractDelta` — `payload?.choices?.[0]?.delta?.content`, иначе `''`.
`reasoning_content` не читается никогда: это размышления модели, в пирамиду
они не идут.

`extractUsage` — `payload?.usage?.completion_tokens`, если это число > 0,
иначе `null`.

`parseApiError` — извлекает сообщение из JSON (`error.message`,
`error.code`, `message`), склеивает `message` и `code` в одну строку-хэйстек,
затем маппинг: по статусу, а для 400 и прочих — по regex
`/quota|rate.?limit|insufficient|billing/i` по всему хэйстеку.

Добавить имена в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/sse.test.mjs
git commit -m "feat: streaming SSE parser and API error mapping"
```

---

### Task 7: API-клиент

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/api-client.test.mjs`

**Interfaces:**
- Consumes: `createSseParser`, `extractDelta`, `extractUsage`, `parseApiError`
  (Task 6); `Config` (Task 1)
- Produces:
  - `requestCompletion(opts: RequestOptions): {abort(): void}`, где
    `RequestOptions = {config: Config, system: string, user: string,
    onDelta(chunk: string): void, onDone(html: string, usage: number|null): void,
    onError(message: string): void, onWaiting?(): void}` — `onWaiting`
    вызывается один раз, когда пришёл первый чанк без `content`
    (`reasoning_content` или role-only), чтобы панель перешла в `thinking`

- [ ] **Step 1: Написать падающий тест `test/api-client.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

function driver() {
  const captured = [];
  const h = loadUserscript({ gmRequest: (details) => {
    captured.push(details);
    return { abort() { details.__aborted = true; } };
  } });
  return { api: h.api, captured };
}

const cfg = (over = {}) => ({ ...loadUserscript().api.DEFAULT_CONFIG, apiKey: 'sk-test', ...over });

function run(over = {}) {
  const { api, captured } = driver();
  const events = { deltas: [], done: [], usage: [], errors: [], waiting: 0 };
  const handle = api.requestCompletion({
    config: cfg(over),
    system: 'SYS',
    user: 'USER',
    onDelta: (d) => events.deltas.push(d),
    onDone: (h, u) => { events.done.push(h); events.usage.push(u); },
    onError: (e) => events.errors.push(e),
    onWaiting: () => { events.waiting += 1; },
  });
  return { api, captured, events, handle };
}

const sse = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('sends bearer header, stream flag and both messages', () => {
  const { captured } = run();
  const d = captured[0];
  assert.equal(d.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(d.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(d.data);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.messages[1].content, 'USER');
});

test('trims trailing slash from apiBase', () => {
  const { captured } = run({ apiBase: 'http://localhost:11434/v1/' });
  assert.equal(captured[0].url, 'http://localhost:11434/v1/chat/completions');
});

test('omits Authorization when apiKey is empty', () => {
  const { captured } = run({ apiKey: '' });
  assert.equal('Authorization' in captured[0].headers, false);
});

test('accumulates deltas and calls onDone with full html', () => {
  const { captured, events } = run();
  const d = captured[0];
  d.onprogress({ responseText: sse('<h3>Hi</h3>') });
  d.onprogress({ responseText: sse('<h3>Hi</h3>') + sse('<p>body</p>') });
  d.onload({ responseText: sse('<h3>Hi</h3>') + sse('<p>body</p>') + 'data: [DONE]\n\n' });
  assert.deepEqual(events.deltas, ['<h3>Hi</h3>', '<p>body</p>']);
  assert.equal(events.done[0], '<h3>Hi</h3><p>body</p>');
  assert.deepEqual(events.errors, []);
});

test('thinking chunks call onWaiting once and never reach onDelta', () => {
  const { captured, events } = run();
  const d = captured[0];
  const reasoning = (t) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: t } }] })}\n\n`;
  d.onprogress({ responseText: reasoning('let me think') });
  d.onprogress({ responseText: reasoning('let me think') + reasoning('more') });
  d.onprogress({ responseText: reasoning('let me think') + reasoning('more') + sse('<p>x</p>') });
  assert.equal(events.waiting, 1);
  assert.deepEqual(events.deltas, ['<p>x</p>']);
});

test('final usage is passed to onDone', () => {
  const { captured, events } = run();
  captured[0].onload({ responseText: sse('<p>x</p>') + `data: ${JSON.stringify({ usage: { completion_tokens: 77 } })}\n\ndata: [DONE]\n\n` });
  assert.equal(events.done[0], '<p>x</p>');
  assert.equal(events.usage[0], 77);
});

test('onDone receives null usage when the server sends none', () => {
  const { captured, events } = run();
  captured[0].onload({ responseText: sse('<p>x</p>') + 'data: [DONE]\n\n' });
  assert.equal(events.usage[0], null);
});

test('falls back to a plain json response body', () => {
  const { captured, events } = run();
  captured[0].onload({ responseText: JSON.stringify({ choices: [{ message: { content: '<p>plain</p>' } }] }) });
  assert.equal(events.done[0], '<p>plain</p>');
});

test('surfaces a 401 as a readable message', () => {
  const { captured, events } = run();
  captured[0].onload({ status: 401, responseText: '{"error":{"message":"bad key"}}' });
  assert.match(events.errors[0], /Неверный ключ API/);
});

test('abort suppresses the following error callback', () => {
  const { captured, events, handle } = run();
  const d = captured[0];
  handle.abort();
  assert.equal(d.__aborted, true);
  d.onerror({ error: 'aborted' });
  assert.deepEqual(events.errors, []);
});

test('network error maps to a connection hint', () => {
  const { captured, events } = run();
  captured[0].onerror({ error: 'network' });
  assert.match(events.errors[0], /Не удалось связаться с API/);
});

test('timeout triggers the timeout message', () => {
  const { captured, events } = run();
  captured[0].ontimeout();
  assert.match(events.errors[0], /Не удалось связаться с API|таймаут/i);
});
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern="requestCompletion|bearer"`
Expected: FAIL.

- [ ] **Step 3: Реализовать `requestCompletion`**

- URL: `config.apiBase.replace(/\/+$/, '') + '/chat/completions'`.
- `headers`: `'Content-Type': 'application/json'`, `Authorization` только при
  непустом `apiKey`.
- `data`: `JSON.stringify({model, temperature, max_tokens: maxTokens, stream: true, messages: [{role:'system',content:system},{role:'user',content:user}]})`.
- `timeout: config.timeoutSec * 1000`.
- Локальное состояние: `seen = 0`, `acc = ''`, `aborted = false`, `done = false`.
- `onprogress`: `const full = d.responseText || ''; const fresh = full.slice(seen); seen = full.length;` → `parser.push(fresh)`; новые дельты дописывать в `acc` и звать `onDelta`.
- `onload`: если `status >= 400` → `onError(parseApiError(status, text))`;
  иначе дописать хвост, попробовать финальный `parser.push` с `'\n\n'`,
  если `acc === ''` — `JSON.parse` целого тела и взять
  `choices[0].message.content`; если после этого пусто → `onError('Модель вернула пустой ответ.')`, иначе `onDone(acc, usage)`.
- `usage` накапливается из `extractUsage` по каждому payload; последнее
  непустое значение побеждает (DeepSeek присылает его в финальном чанке).
- `onWaiting` вызывается максимум один раз: при первом payload, где
  `extractDelta` вернул пустую строку, а `delta.reasoning_content` или
  `delta.role` присутствует.
- `onerror` и `ontimeout` → `parseApiError(0, ...)`.
- `abort()` ставит `aborted = true` и вызывает `handle.abort()`; все колбэки
  начинаются с `if (aborted) return;`.

Добавить имя в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/api-client.test.mjs
git commit -m "feat: streaming OpenAI-compatible client with abort and error mapping"
```

---

### Task 8: Панель (хост, shadow root, состояния, полоса фокуса)

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/panel.test.mjs`

**Interfaces:**
- Produces:
  - `PANEL_ID = 'ai-pyramid-host'`
  - `ensureHost(): {host: HTMLElement, root: ShadowRoot}`
  - `openPanel(): void`, `closePanel(): void`, `isPanelOpen(): boolean`
  - `setPanelState(state: 'extracting'|'requesting'|'thinking'|'streaming'|'done'|'error'|'cached', detail?: {seconds?: number}): void`
  - `setPanelHtml(html: string): void`
  - `getFocusValue(): string`, `setFocusValue(value: string): void`
  - `onRebuild(cb: () => void): void`
  - `onCancel(cb: () => void): void`
  - `onSettings(cb: () => void): void`
  - `setPanelNote(text: string): void`
  - `setSentTextPreview(text: string): void`
  - `showError(message: string, opts?: {settings?: boolean}): void`
  - `setFooter(info: {sent: number, total: number, responseChars: number, model: string, tokens: number|null}): void`
  - `window.__pyramid.__root` — shadow root (только для тестов)

- [ ] **Step 1: Написать падающий тест `test/panel.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const host = (h) => h.document.getElementById('ai-pyramid-host');
const q = (h, sel) => h.window.__pyramid.__root.querySelector(sel);

test('openPanel mounts a shadow host and closePanel removes it', () => {
  const h = loadUserscript();
  h.api.openPanel();
  const el = host(h);
  assert.ok(el);
  assert.equal(el.shadowRoot.querySelector('.panel') !== null, true);
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
  assert.ok(q(h, 'button[data-action="cancel"]'));
});

test('rebuild button and Enter both call the rebuild handler', () => {
  const h = loadUserscript();
  h.api.openPanel();
  let calls = 0;
  h.api.onRebuild(() => { calls += 1; });
  q(h, 'button[data-action="rebuild"]').click();
  const input = q(h, '#pyr-focus');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(calls, 2);
});

test('showError renders the message and a settings button', () => {
  const h = loadUserscript();
  h.api.openPanel();
  h.api.showError('Неверный ключ API', { settings: true });
  assert.match(q(h, '#pyr-content').textContent, /Неверный ключ API/);
  assert.ok(q(h, 'button[data-action="settings"]'));
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
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern=panel`
Expected: FAIL.

- [ ] **Step 3: Реализовать панель**

- `ensureHost` создаёт `div#ai-pyramid-host` c `all: initial`, `position: fixed`,
  `z-index: 2147483646`, `inset: 0`, `pointer-events: none`, `attachShadow({mode:'open'})`.
- Внутри shadow: `<style>` (CSS-переменные темы + `@media (prefers-color-scheme: dark)`,
  панель `width: min(420px, 100vw)`, `height: 100vh`, `translateX(100%)`,
  `details > summary { cursor: pointer }`, кастомный маркер через
  `summary::marker` или `::before`, `details details { margin-left: 18px;
  border-left: 1px solid var(--line) ; padding-left: 10px }`), разметка:
  `.panel > header` (заголовок, бейдж `#pyr-state`, кнопки settings/close),
  `#pyr-focus-bar` (`input#pyr-focus` + `button[data-action="rebuild"]`),
  `#pyr-content`, `footer#pyr-footer`.
- Полоса фокуса и `#pyr-content` — разные узлы: `setPanelHtml` меняет только
  `#pyr-content`, поэтому ввод не теряется.
- `#pyr-note` — отдельная строка под полосой фокуса, `setPanelState` её не
  трогает; предупреждение о коротком тексте живёт там и не мигает при смене
  состояний.
- `#pyr-sent` — `<details><summary>показать отправленный текст</summary><pre>`
  в подвале, текст кладётся через `textContent` (не `innerHTML`), чтобы
  HTML-подобные символы статьи не стали разметкой.
- `setPanelState` переключает класс на панели, текст бейджа и видимость
  `button[data-action="cancel"]`. Для `thinking` бейдж — `модель думает… {n} с`
  с тем же секундным таймером, что и `requesting`: reasoning-модель может
  молчать минуту, и пустая панель неотличима от зависания.
- Подвал собирается как одна строка из тех частей, что есть: символы
  (`отправлено N из M`), `ответ: K символов`, `токенов: T` (только при
  непустом `tokens`), модель.
- Доступность: `.panel` несёт `role="dialog"` и `aria-label="Пирамида
  знаний"`; при открытии фокус ставится в `#pyr-focus`; `X`, «Отменить»,
  «Перестроить» — настоящие `<button>`; `Esc` закрывает.
- `openPanel` снимает `hidden` и ставит `data-open`; `closePanel` ставит
  `hidden` и снимает `data-open`. Обработчик `Escape` вешается в
  capture-фазе на `document`, срабатывает только при открытой панели.
- `onRebuild`/`onCancel`/`onSettings` сохраняют колбэк в переменных модуля;
  клики и `Enter` дергают их.
- `window.__pyramid.__root` — shadow root, только для тестов.

Добавить имена в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/panel.test.mjs
git commit -m "feat: shadow-DOM side panel with focus bar and states"
```

---

### Task 9: Оркестрация и рендер

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/orchestration.test.mjs`

**Interfaces:**
- Consumes: `extractArticle`, `sanitizeHtml`, `buildSystemPrompt`,
  `buildUserMessage`, `requestCompletion`, `cacheKey`/`getCached`/`putCached`,
  все функции панели
- Produces:
  - `runPyramid(opts?: {focus?: string, force?: boolean}): void`
  - `window.__pyramid.__extractText(): string` — извлечённый текст текущей
    страницы тем же путём, что использует `runPyramid` (нужен тестам, чтобы
    строить ключ кэша)
  - `window.__pyramid.__abortRequest(): void` — отмена активного запроса,
    используется кнопкой «Отменить» и хоткеем

- [ ] **Step 1: Написать падающий тест `test/orchestration.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUserscript } from './helpers/load-userscript.mjs';

const ARTICLE = `<!doctype html><html><body><article>
${'<p>The event loop lets JavaScript run non-blocking code on a single thread.</p>'.repeat(12)}
<pre><code class="language-js">setTimeout(() => {}, 0)</code></pre>
</article></body></html>`;

function setup({ store = {}, request = null } = {}) {
  const captured = [];
  const h = loadUserscript({
    html: ARTICLE,
    url: 'https://example.com/a',
    store,
    gmRequest: (d) => {
      captured.push(d);
      return request ? request(d) : { abort() {} };
    },
  });
  return { h, captured, api: h.api };
}

const sse = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

test('renders a cached pyramid without touching the API', () => {
  const { api, captured } = setup();
  api.putCached('https://example.com/a', api.__extractText(), '', '<h3>cached</h3>');
  api.runPyramid();
  assert.equal(captured.length, 0);
  assert.match(api.__root.querySelector('#pyr-content').innerHTML, /cached/);
});

test('streams the answer into the panel and marks the state done', () => {
  const { api, captured } = setup();
  api.runPyramid();
  const d = captured[0];
  d.onprogress({ responseText: sse('<h3>📌 Executive Summary</h3>') });
  d.onprogress({ responseText: sse('<h3>📌 Executive Summary</h3>') + sse('<p>short</p>') });
  d.onload({ responseText: sse('<h3>📌 Executive Summary</h3>') + sse('<p>short</p>') + 'data: [DONE]\n\n' });
  const html = api.__root.querySelector('#pyr-content').innerHTML;
  assert.match(html, /Executive Summary/);
  assert.match(html, /short/);
});

test('empty focus sends the base prompt, non-empty focus sends the focus block', () => {
  const a = setup();
  a.api.runPyramid();
  const bodyA = JSON.parse(a.captured[0].data);
  assert.doesNotMatch(bodyA.messages[0].content, /предмета интереса пользователя/);

  const b = setup();
  b.api.setFocusValue('только архитектура');
  b.api.runPyramid();
  const bodyB = JSON.parse(b.captured[0].data);
  assert.match(bodyB.messages[0].content, /только архитектура/);
});

test('focus is read from the panel input on rebuild', () => {
  const { api, captured } = setup();
  api.runPyramid();
  api.setFocusValue('go examples');
  api.runPyramid();
  const body = JSON.parse(captured[1].data);
  assert.match(body.messages[0].content, /go examples/);
});

test('a second run aborts the first request', () => {
  let aborted = 0;
  const { api, captured } = setup({ request: (d) => ({ abort() { aborted += 1; d.__aborted = true; } }) });
  api.runPyramid();
  api.runPyramid();
  assert.equal(aborted, 1);
});

test('an API error renders the error card and keeps the focus text', () => {
  const { api, captured } = setup();
  api.setFocusValue('architecture');
  api.runPyramid();
  captured[0].onload({ status: 401, responseText: '{"error":{"message":"bad key"}}' });
  assert.match(api.__root.querySelector('#pyr-content').textContent, /Неверный ключ API/);
  assert.equal(api.getFocusValue(), 'architecture');
});

test('model output with a script tag never reaches the panel as markup', () => {
  const { api, captured } = setup();
  api.runPyramid();
  captured[0].onload({ responseText: `data: ${JSON.stringify({ choices: [{ delta: { content: '<p>ok</p><script>alert(1)</script>' } }] })}\n\ndata: [DONE]\n\n` });
  const content = api.__root.querySelector('#pyr-content');
  assert.match(content.innerHTML, /<p>ok<\/p>/);
  assert.doesNotMatch(content.innerHTML, /script/i);
});

test('successful run stores the answer in the cache for the same focus', () => {
  const { api, captured } = setup();
  const text = api.__extractText();
  api.setFocusValue('arch');
  api.runPyramid();
  captured[0].onload({ responseText: `data: ${JSON.stringify({ choices: [{ delta: { content: '<p>done</p>' } }] })}\n\ndata: [DONE]\n\n` });
  assert.match(api.getCached('https://example.com/a', text, 'arch').html, /done/);
});

test('short extracted text shows the not-an-article warning', () => {
  const h = loadUserscript({ html: '<!doctype html><html><body><p>hi</p></body></html>' });
  h.api.runPyramid();
  assert.match(h.api.__root.querySelector('#pyr-note').textContent, /не статья/i);
});
```

> Исполнителю: `api.__extractText()` — хелпер из `__pyramid`, возвращающий
> текст текущей страницы тем же путём, что и `runPyramid`. Он нужен тестам,
> чтобы построить ключ кэша до запуска. Для этого извлечение обязано быть
> детерминированным: один и тот же документ даёт один и тот же текст.

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern=orchestration`
Expected: FAIL.

- [ ] **Step 3: Реализовать `runPyramid`**

1. Если открыт запрос — `abort()`.
2. `openPanel()`, `setPanelState('extracting')`, `setPanelNote('')`.
3. `const cfg = loadConfig()`; `const extracted = extractArticle(document, {autoExtract: cfg.autoExtract, maxChars: cfg.maxChars})`.
4. `setFooter({sent: extracted.text.length, total: extracted.originalLength, responseChars: 0, model: cfg.model, tokens: null})`; `setSentTextPreview(extracted.text)`.
5. Примечание в `#pyr-note`, один слот, приоритет:
   `extracted.truncated` → `Текст обрезан, отправлено {text.length} из {originalLength} символов.`;
   иначе `extracted.short` → `Похоже, это не статья — текст короткий.`;
   иначе пусто.
6. `focus = (opts.focus ?? getFocusValue()).trim()`.
7. Если `!opts.force` и `getCached(location.href, extracted.text, focus)` — отрендерить `sanitizeHtml(cached.html)`, `setPanelState('cached')`, выход.
8. `setPanelState('requesting')`; запустить секундный таймер обновления `detail.seconds` (очищать при завершении/отмене).
9. `requestCompletion({...})` с `system: buildSystemPrompt(focus)`, `user: buildUserMessage(extracted.text)`:
   - `onDelta` — дописать в `acc`, запланировать перерисовку через `setTimeout(..., 200)` (если таймер уже стоит — не дублировать), в таймере `setPanelHtml(sanitizeHtml(acc))`.
   - `onWaiting` — перевести панель в `thinking`, не сбрасывая таймер секунд.
   - `onDone(html, usage)` — снять запланированный таймер, отрисовать `sanitizeHtml(html)` **синхронно**, `putCached(location.href, extracted.text, focus, html)`, `setFooter` с `responseChars: html.length` и `tokens: usage`, `setPanelState('done')`.
   - `onError` — снять таймер, `showError(message, {settings: true})`, `setPanelState('error')`.
10. Сохранить хэндл в модульной переменной; `__abortRequest()` вызывает его `abort()` и `setPanelState('done')`.

Финальный рендер обязан быть синхронным: `onDone` вызывается из колбэка GM, и
тесты, и пользователь должны увидеть результат до того, как поток закроется.
Троттлинг касается только промежуточных кадров.

Добавить имена в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/orchestration.test.mjs
git commit -m "feat: pyramid orchestration with streaming render and cache"
```

---

### Task 10: Настройки, меню, хоткей

**Files:**
- Modify: `pyramid.user.js`
- Test: `test/settings.test.mjs`

**Interfaces:**
- Produces:
  - `openSettings(): void`, `closeSettings(): void`
  - `init(): void`
  - `PRESETS: Array<{name: string, apiBase: string, model: string}>`

- [ ] **Step 1: Написать падающий тест `test/settings.test.mjs`**

```js
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
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', {
    key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true,
  }));
  assert.equal(h.api.isPanelOpen(), true);
});

test('hotkey is ignored while typing in a page input', () => {
  const h = loadUserscript({ html: '<!doctype html><html><body><input id="x"></body></html>' });
  h.api.init();
  const input = h.document.getElementById('x');
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', {
    key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true,
  }));
  assert.equal(h.api.isPanelOpen(), false);
});

test('hotkey toggles the panel closed', () => {
  const h = loadUserscript();
  h.api.init();
  const fire = () => h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', {
    key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true,
  }));
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
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npm test -- --test-name-pattern=settings`
Expected: FAIL.

- [ ] **Step 3: Реализовать**

- `init()`: короткое замыкание от повторной инициализации; регистрирует три
  команды через `GM_registerMenuCommand` («Открыть пирамиду», «Настройки»,
  «Очистить кэш»); вешает `document.addEventListener('keydown', handler, true)`;
  вешает обработчики `onRebuild` → `runPyramid()`, `onCancel` → abort,
  `onSettings` → `openSettings()`.
- Хоткей: `(e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyP'`;
  игнор, если `e.target` — `INPUT`/`TEXTAREA`/`[contenteditable]` вне нашего
  shadow root; `e.preventDefault()`; если панель открыта — закрыть и
  `abort()`, иначе `runPyramid()`.
- `openSettings` монтирует `#pyr-settings` внутрь shadow root (не в
  `document.body`). Поля: `apiBase`, `apiKey` (`type=password`), `model`,
  `maxChars`, `maxTokens`, `temperature`, `timeoutSec`, чекбокс `autoExtract`.
  Кнопки `save`, `close`, пресеты `data-preset="deepseek|openai|openrouter|ollama"`.
  Значения пресетов — дословно из спеки §6.6: `deepseek` →
  `https://api.deepseek.com` / `deepseek-flash`; `openai` →
  `https://api.openai.com/v1` / `gpt-4o-mini`; `openrouter` →
  `https://openrouter.ai/api/v1` / `deepseek/deepseek-chat`; `ollama` →
  `http://localhost:11434/v1` / `llama3.1`.
  Подсказка про `OLLAMA_ORIGINS=*`.

Добавить имена в `__pyramid`.

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add pyramid.user.js test/settings.test.mjs
git commit -m "feat: settings dialog, menu commands and global hotkey"
```

---

### Task 11: Стенд и README

**Files:**
- Create: `test/mock-server.mjs`
- Create: `test/fixture.html`
- Create: `README.md`

**Interfaces:**
- Consumes: `pyramid.user.js` (загружается в браузере)
- Produces: HTTP-сервер на `http://127.0.0.1:8787` с путём
  `/v1/chat/completions`

- [ ] **Step 1: Написать `test/mock-server.mjs`**

Node ≥ 18, только `node:http` и `node:fs`. Отдаёт `test/fixture.html` на `/`
и `pyramid.user.js` на `/pyramid.user.js` (иначе скрипт из разметки не
загрузится), принимает `POST /v1/chat/completions`.

Флаги (в query string):
- `?fail=401`, `?fail=429`, `?fail=500` — JSON-ошибка с соответствующим
  статусом.
- `?plain=1` — целый JSON вместо SSE.
- `?slow=1` — SSE с задержкой 150 мс между чанками.
- `?xss=1` — в потоке `<script>alert(1)</script>` и
  `<img src=x onerror=alert(2)>`.
- `?think=1` (по умолчанию включено) — перед `content` отдаёт 5 чанков с
  `delta.reasoning_content`, чтобы панель перешла в `thinking` и не выглядела
  зависшей.
- `?usage=0` — не присылать финальный `usage`, чтобы проверить подвал без
  токенов.

Финальный чанк `usage` присылается всегда, если не задан `?usage=0`:
`{"usage":{"completion_tokens":412,"prompt_tokens":900}}` — так же, как
DeepSeek в своих доках.

Всегда, независимо от флагов, в конец пирамиды дописывает блок
`<details><summary>debug: system prompt</summary><pre>…</pre></details>` с
присланным system-сообщением. Так подмешивание фокуса проверяется глазами, без
отдельного флага и без трат токенов.

По умолчанию — SSE с фиксированной пирамидой (exec summary, три `details`
второго уровня, в каждом два вложенных `details`, в основании `<ul>`).

- [ ] **Step 2: Написать `test/fixture.html`**

Страница-статья (~1500 символов, блок кода) и шим `GM_*` до подключения
скрипта:

```html
<script>
  const LS = { get: (k, d) => { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); },
               set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
               del: (k) => localStorage.removeItem(k),
               keys: () => Object.keys(localStorage) };
  window.GM_getValue = LS.get;
  window.GM_setValue = LS.set;
  window.GM_deleteValue = LS.del;
  window.GM_listValues = LS.keys;
  window.GM_registerMenuCommand = (n, f) => { window.__menu = window.__menu || []; window.__menu.push({ n, f }); };
  window.GM_xmlhttpRequest = (d) => {
    const ctrl = new AbortController();
    const url = d.url + (window.location.search || '');
    fetch(url, { method: d.method || 'GET', headers: d.headers, body: d.data, signal: ctrl.signal })
      .then(async (res) => {
        if (!res.body) {
          const text = await res.text();
          if (d.onload) d.onload({ status: res.status, responseText: text });
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (d.onprogress) d.onprogress({ responseText: acc });
        }
        if (d.onload) d.onload({ status: res.status, responseText: acc });
      })
      .catch((e) => { if (d.onerror && e.name !== 'AbortError') d.onerror({ error: String(e) }); });
    return { abort: () => ctrl.abort() };
  };
  window.__PYRAMID_TEST_HOOK__ = false;
  localStorage.setItem('pyr.config', JSON.stringify({
    apiBase: 'http://127.0.0.1:8787/v1',
    apiKey: '',
    model: 'mock',
  }));
</script>
<script src="../pyramid.user.js"></script>
```

Ключ API в стенде не нужен: `mock-server` игнорирует `Authorization`.
Конфиг кладётся прямо в `localStorage`, поэтому настройки руками вводить не
надо, а `apiBase` совпадает по origin с самой страницей — CORS не мешает.

- [ ] **Step 3: Написать `README.md`**

Разделы: что это; установка (Tampermonkey/Violentmonkey → создать скрипт →
вставить `pyramid.user.js`); настройка (OpenAI/OpenRouter/DeepSeek/Ollama,
`OLLAMA_ORIGINS=*`); горячая клавиша и поле фокуса; кэш и его очистка;
запуск тестов `npm test`; запуск стенда
`node test/mock-server.mjs` + `http://127.0.0.1:8787/` (в настройках
`apiBase: http://127.0.0.1:8787/v1` — именно `127.0.0.1`, не `localhost`,
иначе другой origin и CORS); ограничения (пейволы, SPA, очень длинные
статьи); лицензия Readability.

- [ ] **Step 4: Проверить стенд вручную**

Run: `node test/mock-server.mjs &` затем
`curl -s -X POST 'http://127.0.0.1:8787/v1/chat/completions?plain=1' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"x"}]}' | head -c 200`
Expected: JSON с `choices[0].message.content`, содержащим `<h3>`.

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://127.0.0.1:8787/v1/chat/completions?fail=401' -d '{}'`
Expected: `401`.

- [ ] **Step 5: Коммит**

```bash
git add test/mock-server.mjs test/fixture.html README.md
git commit -m "test: local mock SSE server, browser fixture and README"
```

---

### Task 12: Финальная приёмка

**Files:**
- Modify: `README.md` (раздел «Что проверено»)

- [ ] **Step 1: Прогнать полный набор тестов**

Run: `npm test`
Expected: PASS, 0 падений, все файлы `test/*.test.mjs` участвуют.

- [ ] **Step 2: Проверить, что артефакт автономен**

Run: `grep -nE "^\s*(import|require)\s*[\(a-zA-Z{]" pyramid.user.js`
Expected: пусто — ни импортов, ни `require`.

Run: `grep -n "await fetch\|window.fetch" pyramid.user.js`
Expected: пусто — сеть только через `GM_xmlhttpRequest`.

Run: `grep -c "GM_xmlhttpRequest" pyramid.user.js`
Expected: ≥ 2 (грант в шапке и вызов в клиенте).

- [ ] **Step 3: Проверить шапку на соответствие спеке**

Run: `sed -n '1,20p' pyramid.user.js`
Expected: `@match http://*/*`, `@match https://*/*`, `@connect *`,
пять `@grant` включая `GM_listValues` и `GM_deleteValue`,
`@run-at document-idle`.

- [ ] **Step 4: Прогон стенда по сценариям**

С `node test/mock-server.mjs`, открыть `http://127.0.0.1:8787/`:
1. Хоткей → панель открывается, стримится пирамида.
2. Ввод «только архитектура» → «Перестроить» → в конце пирамиды открыть блок
   `debug: system prompt` и убедиться, что фокус там есть.
3. Открыть `http://127.0.0.1:8787/?fail=401` → карточка «Неверный ключ API»
   с кнопкой «Настройки».
4. Открыть `http://127.0.0.1:8787/?xss=1` → `<script>` не исполняется, тегов
   в разметке нет.
5. Открыть `http://127.0.0.1:8787/?plain=1` → ответ без стриминга всё равно
   рендерится.
6. Открыть `http://127.0.0.1:8787/?slow=1` → «Отменить» прерывает поток,
   частичная пирамида остаётся.
7. Открыть `http://127.0.0.1:8787/?think=1` → бейдж «модель думает…» с
   таймером до прихода первого `content`, панель не пустая.
8. Открыть `http://127.0.0.1:8787/?usage=0` → в подвале нет строки про
   токены; без флага — есть.

Флаги живут в URL страницы, а не в `apiBase`: шим в `fixture.html` дописывает
`location.search` к `d.url` перед `fetch`, так что сервер видит режим в query
самого запроса. Без параметров работает дефолтный сценарий.

- [ ] **Step 5: Записать результат в README**

Раздел «Что проверено»: список из Step 4 с отметками и датой.

- [ ] **Step 6: Коммит**

```bash
git add README.md
git commit -m "docs: record acceptance run results"
```

---

## Что остаётся за пределами плана

Реальная проверка на живых сайтах и с настоящим API — за человеком: нужен
ключ и сеть. Стенд покрывает всё, что можно проверить без токенов; список
сайтов по типам вёрстки — в спеке §9, критерии — там же.

Ключ DeepSeek в репозиторий и в план не попадает. Живая проверка: настройки
панели → пресет DeepSeek → вставить ключ в поле `type=password` → сохранить.
Если понадобится автоматический smoke-тест, ключ читается из переменной
окружения `DEEPSEEK_API_KEY`, а `.env` добавляется в `.gitignore`; запуск —
только по явной команде человека, потому что тратит его кредиты.
