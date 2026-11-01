// ==UserScript==
// @name         AI Multi-level Artifact Pyramid Reader
// @namespace    http://tampermonkey.net
// @version      1.0
// @description  Генерация многоуровневой пирамиды тезисов по горячим клавишам
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const CONFIG_KEY = 'pyr.config';

  const HOTKEY_FIELDS = ['toggle', 'wide', 'focus'];
  const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

  const RESERVED_COMBOS = [
    'Ctrl+P', 'Ctrl+S', 'Ctrl+F', 'Ctrl+T', 'Ctrl+W', 'Ctrl+N', 'Ctrl+O',
    'Ctrl+Shift+P', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C',
    'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Shift+Q',
    'F5', 'F11', 'F12',
  ];

  function isMacPlatform() {
    try {
      const nav = globalThis.navigator || {};
      return /Mac|iPhone|iPad|iPod/i.test(String(nav.platform || '') + ' ' + String(nav.userAgent || ''));
    } catch (error) {
      return false;
    }
  }

  function defaultHotkeys() {
    const mod = isMacPlatform() ? 'Ctrl+Alt' : 'Alt';
    return {
      toggle: mod + '+P',
      wide: mod + '+M',
      focus: mod + '+Q',
    };
  }

  function normalizeKeyName(key) {
    const raw = String(key == null ? '' : key).trim();
    if (!raw) return '';
    if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
    if (raw.length === 1) return raw.toUpperCase();
    return raw;
  }

  function comboParts(combo) {
    const raw = String(combo == null ? '' : combo)
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean);

    if (raw.length === 0) return null;

    const key = normalizeKeyName(raw[raw.length - 1]);
    const mods = raw.slice(0, -1);
    if (!key) return null;
    if (mods.length === 0 && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return null;
    if (!mods.every((mod) => MODIFIER_ORDER.indexOf(mod) !== -1)) return null;
    if (new Set(mods).size !== mods.length) return null;

    return { key, mods };
  }

  function canonicalCombo(combo) {
    const parsed = comboParts(combo);
    if (!parsed) return '';
    const mods = MODIFIER_ORDER.filter((mod) => parsed.mods.indexOf(mod) !== -1);
    return mods.concat(parsed.key).join('+');
  }

  function isUsableCombo(combo) {
    const parsed = comboParts(combo);
    if (!parsed) return false;
    if (parsed.mods.some((mod) => mod === 'Ctrl' || mod === 'Alt' || mod === 'Meta')) return true;
    return /^F([1-9]|1[0-9]|2[0-4])$/.test(parsed.key);
  }

  function isReservedCombo(combo) {
    return RESERVED_COMBOS.indexOf(canonicalCombo(combo)) !== -1;
  }

  function keyNameOf(event) {
    const code = String(event.code || '');

    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return 'Num' + code.slice(6);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (
      /^(Escape|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(
        code,
      )
    ) {
      return code;
    }

    return normalizeKeyName(event.key);
  }

  function eventToCombo(event) {
    const key = keyNameOf(event);
    if (!key) return '';

    const mods = [];
    if (event.ctrlKey) mods.push('Ctrl');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Meta');
    mods.push(key);

    return mods.join('+');
  }

  function coerceHotkeys(raw) {
    const defaults = defaultHotkeys();
    const source = raw && typeof raw === 'object' ? raw : {};
    const out = {};

    HOTKEY_FIELDS.forEach((field) => {
      const value = typeof source[field] === 'string' ? source[field].trim() : '';
      out[field] = isUsableCombo(value) ? canonicalCombo(value) : defaults[field];
    });

    return out;
  }

  const DEFAULT_CONFIG = {
    apiBase: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-flash',
    maxChars: 60000,
    maxTokens: 8192,
    temperature: 0.3,
    timeoutSec: 180,
    autoExtract: true,
    thinking: false,
    language: 'auto',
    hotkeys: defaultHotkeys(),
  };

  const LANGUAGES = ['auto', 'ru', 'en'];

  const NUMERIC_LIMITS = {
    maxChars: [1000, 400000],
    maxTokens: [256, 32000],
    temperature: [0, 2],
    timeoutSec: [10, 600],
  };

  // ---------------------------------------------------------------------------
  // Storage (GM_* with localStorage fallback)
  // ---------------------------------------------------------------------------

  function hasGm() {
    return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  }

  function storageGet(key, fallback) {
    try {
      if (hasGm()) {
        const value = GM_getValue(key, undefined);
        return value === undefined ? fallback : value;
      }
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      if (hasGm()) {
        GM_setValue(key, value);
        return;
      }
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* storage is best-effort: a full or blocked store must not break the run */
    }
  }

  function storageDelete(key) {
    try {
      if (hasGm() && typeof GM_deleteValue === 'function') {
        GM_deleteValue(key);
        return;
      }
      window.localStorage.removeItem(key);
    } catch (error) {
      /* best-effort */
    }
  }

  function storageKeys() {
    try {
      if (hasGm() && typeof GM_listValues === 'function') {
        return GM_listValues() || [];
      }
      return Object.keys(window.localStorage);
    } catch (error) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Config merge
  // ---------------------------------------------------------------------------

  function clampNumber(name, value) {
    const limits = NUMERIC_LIMITS[name];
    const num = Number(value);
    if (!Number.isFinite(num)) return DEFAULT_CONFIG[name];
    return Math.min(limits[1], Math.max(limits[0], num));
  }

  function coerceConfig(raw) {
    const merged = Object.assign({}, DEFAULT_CONFIG, raw || {});
    const config = {};

    config.apiBase = String(merged.apiBase || DEFAULT_CONFIG.apiBase).trim();
    config.apiKey = String(merged.apiKey == null ? '' : merged.apiKey).trim();
    config.model = String(merged.model || DEFAULT_CONFIG.model).trim();

    config.maxChars = clampNumber('maxChars', merged.maxChars);
    config.maxTokens = clampNumber('maxTokens', merged.maxTokens);
    config.temperature = clampNumber('temperature', merged.temperature);
    config.timeoutSec = clampNumber('timeoutSec', merged.timeoutSec);

    if (typeof merged.autoExtract === 'string') {
      config.autoExtract = merged.autoExtract !== 'false';
    } else {
      config.autoExtract = Boolean(merged.autoExtract);
    }

    if (typeof merged.thinking === 'string') {
      config.thinking = merged.thinking === 'true';
    } else {
      config.thinking = Boolean(merged.thinking);
    }

    config.language = LANGUAGES.indexOf(merged.language) !== -1 ? merged.language : 'auto';
    config.hotkeys = coerceHotkeys(merged.hotkeys);

    return config;
  }

  const LEGACY_MAX_TOKENS = 4096;

  function migrateConfig(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    if (typeof raw.thinking === 'boolean') return raw;

    const legacy = Object.assign({}, raw);
    if (Number(legacy.maxTokens) === LEGACY_MAX_TOKENS) {
      legacy.maxTokens = DEFAULT_CONFIG.maxTokens;
    }
    legacy.thinking = DEFAULT_CONFIG.thinking;
    storageSet(CONFIG_KEY, coerceConfig(legacy));
    return legacy;
  }

  function loadConfig() {
    const stored = storageGet(CONFIG_KEY, null);
    if (stored === null) return coerceConfig(null);
    if (typeof stored === 'string') {
      try {
        return coerceConfig(migrateConfig(JSON.parse(stored)));
      } catch (error) {
        return coerceConfig(null);
      }
    }
    return coerceConfig(migrateConfig(stored));
  }

  function saveConfig(patch) {
    const next = coerceConfig(Object.assign({}, loadConfig(), patch || {}));
    storageSet(CONFIG_KEY, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------------------

  const CACHE_PREFIX = 'pyr.cache.';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 10;
  const CACHE_MAX_BYTES = 98304;

  let lastCacheTs = 0;

  function djb2(input) {
    let hash = 5381;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function cacheKey(url, text, focus, language) {
    const body =
      url +
      '|' +
      String(text).length +
      '|' +
      String(text).slice(0, 64) +
      '|' +
      (focus || '') +
      '|' +
      (language || '');
    return CACHE_PREFIX + djb2(body).toString(36);
  }

  function cacheKeys() {
    return storageKeys().filter((key) => key.startsWith(CACHE_PREFIX));
  }

  function pruneCache() {
    const entries = cacheKeys().map((key, index) => {
      const value = storageGet(key, null);
      const ts = value && typeof value.ts === 'number' ? value.ts : 0;
      return { key, ts, index };
    });

    entries.sort((a, b) => (b.ts - a.ts) || (b.index - a.index));

    entries.slice(CACHE_MAX_ENTRIES).forEach((entry) => storageDelete(entry.key));
  }

  function putCached(url, text, focus, html, language) {
    const key = cacheKey(url, text, focus, language);
    lastCacheTs = Math.max(Date.now(), lastCacheTs + 1);
    storageSet(key, {
      ts: lastCacheTs,
      html: String(html).slice(0, CACHE_MAX_BYTES),
      focus: focus || '',
    });
    pruneCache();
  }

  function getCached(url, text, focus, language) {
    const key = cacheKey(url, text, focus, language);
    const entry = storageGet(key, null);

    if (!entry || typeof entry !== 'object') return null;
    if ((entry.focus || '') !== (focus || '')) return null;

    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      storageDelete(key);
      return null;
    }

    return entry;
  }

  function clearCache() {
    cacheKeys().forEach((key) => storageDelete(key));
  }

  // ---------------------------------------------------------------------------
  // Sanitizer
  // ---------------------------------------------------------------------------

  const ALLOWED_TAGS = new Set([
    'h3', 'h4', 'h5', 'p', 'ul', 'ol', 'li', 'details', 'summary', 'strong',
    'b', 'em', 'i', 'code', 'pre', 'blockquote', 'br', 'hr', 'span', 'div',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ]);

  const DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'img', 'svg', 'link',
    'meta', 'form', 'input', 'template', 'noscript', 'base', 'audio', 'video',
    'source', 'track', 'canvas', 'math',
  ]);

  const CITATION_ATTR = 'data-src';
  const CITATION_TAGS = new Set(['details', 'summary', 'li']);
  const CITATION_MAX_CHARS = 400;

  function stripAttributes(element, tag) {
    const citation = CITATION_TAGS.has(tag) ? element.getAttribute(CITATION_ATTR) : null;

    while (element.attributes.length > 0) {
      element.removeAttribute(element.attributes[0].name);
    }

    if (citation) {
      element.setAttribute(
        CITATION_ATTR,
        String(citation).replace(/\s+/g, ' ').trim().slice(0, CITATION_MAX_CHARS),
      );
    }
  }

  function unwrap(element) {
    const parent = element.parentNode;
    if (!parent) return;
    while (element.firstChild) parent.insertBefore(element.firstChild, element);
    element.remove();
  }

  function cleanChildren(node) {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === 8) {
        child.remove();
        return;
      }
      if (child.nodeType !== 1) return;

      const tag = child.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) {
        child.remove();
        return;
      }

      cleanChildren(child);

      if (!ALLOWED_TAGS.has(tag)) {
        unwrap(child);
        return;
      }

      stripAttributes(child, tag);
    });
  }

  function normalizePyramidLabels(html) {
    return String(html == null ? '' : html).replace(/Многоуровневые Тезисы/g, 'Тезисы');
  }

  function stripMarkdownFence(text) {
    let out = String(text == null ? '' : text);
    out = out.replace(/^\s*```[a-zA-Z0-9_-]*[ \t]*\r?\n/, '');
    out = out.replace(/\r?\n?```[ \t]*$/, '');
    return out;
  }

  function prepareHtml(html) {
    return normalizePyramidLabels(sanitizeHtml(stripMarkdownFence(html)));
  }

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
    cleanChildren(doc.body);
    return doc.body.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Prompt
  // ---------------------------------------------------------------------------

  const LANGUAGE_CLAUSES = {
    auto: 'на языке статьи (русский текст — по-русски, английский — по-английски, и так\nдалее)',
    ru: 'на русском языке',
    en: 'на английском языке',
  };

  const LANGUAGE_ANSWER_TAILS = {
    auto: 'Язык ответа — язык статьи.',
    ru: 'Язык ответа — русский.',
    en: 'Язык ответа — английский.',
  };

  const BASE_PROMPT_HEAD = 'Проанализируй текст статьи и сформируй ГЛУБОКУЮ МНОГОУРОВНЕВУЮ Пирамиду Знаний';

  const BASE_PROMPT_TAIL = [
    'Используй вложенные HTML-теги <details> и <summary> для',
    'прогрессивного раскрытия информации. Отвечай ТОЛЬКО чистым HTML-кодом без',
    'markdown-оберток (без ```html).',
    '',
    'Структура ответа:',
    '- <h3>📌 Executive Summary</h3> + 2-3 предложения сути статьи.',
    '- <h3>📐 Тезисы</h3>',
    '- Уровень 2: 3-5 главных тем статьи в тегах <details>. Внутри <summary> пиши',
    '  четкий тезис.',
    '- Уровень 3 (Вложенный): Внутри каждого тега Уровня 2 должно быть 2-3 подтезиса',
    '  (тоже в тегах <details>).',
    '- Уровень 4 (Основание пирамиды): Внутри подтезисов Уровня 3 должны лежать',
    '  атомарные факты, цифры, примеры кода или цитаты в виде списков <ul>/<li>.',
  ].join('\n');

  function basePrompt(language) {
    const clause = LANGUAGE_CLAUSES[language] || LANGUAGE_CLAUSES.auto;
    return BASE_PROMPT_HEAD + '\n' + clause + '.\n' + BASE_PROMPT_TAIL;
  }

  const BASE_PROMPT = basePrompt('auto');

  const PROMPT_RULES = [
    'Не используй атрибуты style, class, id, href, src и любые inline-стили.',
    'Вложенность второго уровня оформляй обычной вложенностью <details>, без',
    'margin-left. Не выводи ничего, кроме HTML.',
  ].join('\n');

  const CITATION_RULES = [
    'Для каждого <summary> внутри <details> и для каждого <li> добавь атрибут',
    'data-src с дословной цитатой из статьи (5-12 слов), скопированной символ в',
    'символ из исходного текста. Цитата должна находиться в статье буквально.',
    'Других атрибутов не используй.',
  ].join('\n');

  const FOCUS_TEMPLATE = [
    'Сформируй пирамиду строго относительно следующего предмета интереса пользователя: <текст из поля ввода>',
    '',
    'Если в статье нет материала по этому предмету, так и напиши в Executive',
    'Summary и не выдумывай факты. <хвост про язык>',
  ].join('\n');

  function buildSystemPrompt(focus, language) {
    const lang = LANGUAGES.indexOf(language) !== -1 ? language : 'auto';
    const blocks = [basePrompt(lang), PROMPT_RULES, CITATION_RULES];
    const trimmed = String(focus == null ? '' : focus).trim();
    if (trimmed) {
      blocks.push(
        FOCUS_TEMPLATE.replace('<текст из поля ввода>', () => trimmed).replace(
          '<хвост про язык>',
          () => LANGUAGE_ANSWER_TAILS[lang],
        ),
      );
    }
    return blocks.join('\n\n');
  }

  function buildUserMessage(text) {
    return 'Статья:\n\n' + String(text == null ? '' : text);
  }

  // ---------------------------------------------------------------------------
  // Source jump
  // ---------------------------------------------------------------------------

  const SOURCE_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'ASIDE', 'FOOTER', 'FORM',
    'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'TEMPLATE',
  ]);

  const SOURCE_SKIP_CLASSES = ['cookie', 'newsletter', 'subscribe'];
  const SOURCE_MAX_TOKENS = 200000;
  const SOURCE_MIN_FALLBACK_TOKENS = 3;

  function sourceWordPattern() {
    return /[\p{L}\p{N}]+/gu;
  }

  function isSkippedForSource(element) {
    if (!element) return true;
    if (panelRefs && panelRefs.host && panelRefs.host.contains(element)) return true;
    if (SOURCE_SKIP_TAGS.has(element.tagName)) return true;
    return SOURCE_SKIP_CLASSES.some((name) => element.classList.contains(name));
  }

  function collectSourceTokens(root) {
    const tokens = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let element = node.parentElement;
        while (element && element !== root) {
          if (isSkippedForSource(element)) return NodeFilter.FILTER_REJECT;
          element = element.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node && tokens.length < SOURCE_MAX_TOKENS) {
      const pattern = sourceWordPattern();
      let match = pattern.exec(node.nodeValue);
      while (match) {
        tokens.push({
          word: match[0].toLowerCase(),
          node,
          start: match.index,
          end: match.index + match[0].length,
        });
        match = pattern.exec(node.nodeValue);
      }
      node = walker.nextNode();
    }

    return tokens;
  }

  function wordsOf(text) {
    const found = String(text == null ? '' : text).match(sourceWordPattern()) || [];
    return found.map((word) => word.toLowerCase());
  }

  function matchTokenRun(tokens, target) {
    if (target.length === 0) return null;
    const limit = tokens.length - target.length;

    for (let start = 0; start <= limit; start += 1) {
      let matched = true;
      for (let index = 0; index < target.length; index += 1) {
        if (tokens[start + index].word !== target[index]) {
          matched = false;
          break;
        }
      }
      if (matched) return { from: start, to: start + target.length - 1 };
    }

    return null;
  }

  function findArticleMatch(citation) {
    const target = wordsOf(citation);
    if (target.length === 0) return null;

    const tokens = collectSourceTokens(document.body);
    if (tokens.length === 0) return null;

    let run = matchTokenRun(tokens, target);

    for (let length = target.length - 1; !run && length >= SOURCE_MIN_FALLBACK_TOKENS; length -= 1) {
      run = matchTokenRun(tokens, target.slice(0, length));
    }

    if (!run) return null;

    const first = tokens[run.from];
    const last = tokens[run.to];
    const range = document.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);

    return { element: first.node.parentElement, range };
  }

  function flashSourceHit(element) {
    let rect = null;
    try {
      rect = element.getBoundingClientRect();
    } catch (error) {
      rect = null;
    }

    const box = document.createElement('div');
    box.className = 'pyr-source-hit';
    const geometry = rect && rect.width > 0
      ? 'left:' + Math.max(0, rect.left - 4) + 'px;top:' + Math.max(0, rect.top - 4) +
        'px;width:' + (rect.width + 8) + 'px;height:' + (rect.height + 8) + 'px;'
      : 'left:0;top:0;width:100%;height:3px;';

    box.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #2563eb;' +
      'border-radius:6px;background:rgba(37,99,235,0.14);transition:opacity 0.35s ease;' +
      geometry;

    document.body.appendChild(box);
    setTimeout(() => {
      box.style.opacity = '0';
    }, 1100);
    setTimeout(() => {
      box.remove();
    }, 1600);
  }

  function jumpToSource(citation) {
    const hit = findArticleMatch(citation);
    if (!hit) return false;

    try {
      hit.element.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (error) {
      /* older engines ignore the options bag */
    }

    flashSourceHit(hit.element);
    return true;
  }

  let noteBase = '';
  let noteTimer = null;

  function setTransientNote(text, ms) {
    const refs = ensureHost();
    refs.note.textContent = text;
    if (noteTimer != null) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      noteTimer = null;
      if (refs.note) refs.note.textContent = noteBase;
    }, ms || 2600);
  }

  function citationOf(element) {
    if (!element) return '';
    const explicit = element.getAttribute('data-src');
    if (explicit && explicit.trim()) return explicit.trim();
    return element.textContent || '';
  }

  function handleSourceClick(event) {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;

    const anchor = target.closest('summary, li');
    if (!anchor) return;

    const citation = citationOf(anchor);
    if (!citation) return;

    if (!jumpToSource(citation)) {
      setTransientNote('Не нашёл это место в статье.');
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };

  function slugify(text) {
    const transliterated = String(text == null ? '' : text)
      .toLowerCase()
      .split('')
      .map((char) => (TRANSLIT[char] !== undefined ? TRANSLIT[char] : char))
      .join('');
    return (
      transliterated
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'pyramid'
    );
  }

  function todayStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  function exportFilename(format) {
    const title = document.title || '';
    return slugify(title) + '-' + todayStamp() + (format === 'org' ? '.org' : '.md');
  }

  function inlineMarkup(node, format) {
    let out = '';

    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += String(child.nodeValue || '').replace(/\s+/g, ' ');
        return;
      }
      if (child.nodeType !== 1) return;

      const tag = child.tagName.toLowerCase();
      const inner = inlineMarkup(child, format);

      if (tag === 'br') {
        out += ' ';
        return;
      }
      if (tag === 'strong' || tag === 'b') {
        out += format === 'org' ? '*' + inner + '*' : '**' + inner + '**';
        return;
      }
      if (tag === 'em' || tag === 'i') {
        out += format === 'org' ? '/' + inner + '/' : '*' + inner + '*';
        return;
      }
      if (tag === 'code') {
        out += format === 'org' ? '~' + inner + '~' : '`' + inner + '`';
        return;
      }
      out += inner;
    });

    return out.replace(/[ \t]+/g, ' ').trim();
  }

  function codeBlock(pre, format) {
    const code = pre.querySelector('code') || pre;
    const className = String(code.className || '') + ' ' + String(pre.className || '');
    const match = className.match(/language-([\w-]+)/);
    const language = match ? match[1] : '';
    const body = String(code.textContent || '').replace(/\n+$/, '');

    if (format === 'org') {
      return ['#+begin_src ' + language, body, '#+end_src'];
    }
    return ['```' + language, body, '```'];
  }

  function listLines(list, indent, format) {
    const lines = [];
    const ordered = list.tagName.toLowerCase() === 'ol';
    let index = 1;

    Array.from(list.children).forEach((item) => {
      if (item.tagName.toLowerCase() !== 'li') return;
      const nested = Array.from(item.children).filter((child) =>
        ['ul', 'ol'].includes(child.tagName.toLowerCase()),
      );
      const prose = inlineMarkup(item, format);
      const marker = ordered ? index + '. ' : '- ';
      lines.push(indent + marker + prose);
      nested.forEach((child) => {
        lines.push(...listLines(child, indent + '  ', format));
      });
      index += 1;
    });

    return lines;
  }

  function tableLines(table, format) {
    const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
      Array.from(row.children)
        .map((cell) => inlineMarkup(cell, format))
        .join(' | '),
    );
    if (rows.length === 0) return [];
    if (format === 'org') return rows.map((row) => '| ' + row + ' |');
    if (rows.length === 1) return rows.map((row) => '| ' + row + ' |');
    const header = '| ' + rows[0] + ' |';
    const divider = '|' + rows[0].split('|').map(() => ' --- |').join('');
    return [header, divider, ...rows.slice(1).map((row) => '| ' + row + ' |')];
  }

  function blockLines(node, level, format) {
    const lines = [];

    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = String(child.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (text) lines.push(text);
        return;
      }
      if (child.nodeType !== 1) return;

      const tag = child.tagName.toLowerCase();
      const headingMarker = format === 'org' ? '*' : '#';

      if (tag === 'h3' || tag === 'h4' || tag === 'h5') {
        const depth = Math.max(1, level + (Number(tag.slice(1)) - 3));
        lines.push(headingMarker.repeat(depth) + ' ' + inlineMarkup(child, format), '');
        return;
      }

      if (tag === 'details') {
        const summary = Array.from(child.children).find(
          (element) => element.tagName.toLowerCase() === 'summary',
        );
        if (summary) {
          lines.push(headingMarker.repeat(level + 1) + ' ' + inlineMarkup(summary, format), '');
        }
        lines.push(...blockLines(child, level + 1, format));
        return;
      }

      if (tag === 'summary') return;

      if (tag === 'p') {
        const text = inlineMarkup(child, format);
        if (text) lines.push(text, '');
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        lines.push(...listLines(child, '', format), '');
        return;
      }

      if (tag === 'pre') {
        lines.push(...codeBlock(child, format), '');
        return;
      }

      if (tag === 'blockquote') {
        const inner = blockLines(child, level, format)
          .filter((line) => line !== '')
          .join('\n');
        if (format === 'org') {
          lines.push('#+begin_quote', inner, '#+end_quote', '');
        } else {
          lines.push(
            ...inner.split('\n').map((line) => '> ' + line),
            '',
          );
        }
        return;
      }

      if (tag === 'hr') {
        lines.push(format === 'org' ? '-----' : '---', '');
        return;
      }

      if (tag === 'table') {
        lines.push(...tableLines(child, format), '');
        return;
      }

      lines.push(...blockLines(child, level, format));
    });

    return lines;
  }

  function pyramidToText(html, title, format) {
    const doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
    const marker = format === 'org' ? '*' : '#';
    const lines = [];

    if (title) lines.push(marker + ' ' + String(title).trim(), '');

    const baseLevel = format === 'org' ? (title ? 2 : 1) : 2;
    lines.push(...blockLines(doc.body, baseLevel, format));

    const text = lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text ? text + '\n' : '';
  }

  function pyramidToMarkdown(html, title) {
    return pyramidToText(html, title, 'md');
  }

  function pyramidToOrg(html, title) {
    return pyramidToText(html, title, 'org');
  }

  function exportPyramid(format) {
    if (!lastRenderedHtml) return null;
    const title = document.title || '';
    const text =
      format === 'org' ? pyramidToOrg(lastRenderedHtml, title) : pyramidToMarkdown(lastRenderedHtml, title);
    if (!text) return null;
    return { filename: exportFilename(format), text };
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadPyramid(format) {
    const result = exportPyramid(format);
    if (!result) return false;
    downloadText(result.filename, result.text);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Readability (vendored)
  // ---------------------------------------------------------------------------

  // >>> BEGIN READABILITY (vendored @mozilla/readability 0.5.0, Apache-2.0)
/*
 * Copyright (c) 2010 Arc90 Inc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This code is heavily based on Arc90's readability.js (1.7.1) script
 * available at: http://code.google.com/p/arc90labs-readability
 */

/**
 * Public constructor.
 * @param {HTMLDocument} doc     The document to parse.
 * @param {Object}       options The options object.
 */
function Readability(doc, options) {
  // In some older versions, people passed a URI as the first argument. Cope:
  if (options && options.documentElement) {
    doc = options;
    options = arguments[2];
  } else if (!doc || !doc.documentElement) {
    throw new Error("First argument to Readability constructor should be a document object.");
  }
  options = options || {};

  this._doc = doc;
  this._docJSDOMParser = this._doc.firstChild.__JSDOMParser__;
  this._articleTitle = null;
  this._articleByline = null;
  this._articleDir = null;
  this._articleSiteName = null;
  this._attempts = [];

  // Configurable options
  this._debug = !!options.debug;
  this._maxElemsToParse = options.maxElemsToParse || this.DEFAULT_MAX_ELEMS_TO_PARSE;
  this._nbTopCandidates = options.nbTopCandidates || this.DEFAULT_N_TOP_CANDIDATES;
  this._charThreshold = options.charThreshold || this.DEFAULT_CHAR_THRESHOLD;
  this._classesToPreserve = this.CLASSES_TO_PRESERVE.concat(options.classesToPreserve || []);
  this._keepClasses = !!options.keepClasses;
  this._serializer = options.serializer || function(el) {
    return el.innerHTML;
  };
  this._disableJSONLD = !!options.disableJSONLD;
  this._allowedVideoRegex = options.allowedVideoRegex || this.REGEXPS.videos;

  // Start with all flags set
  this._flags = this.FLAG_STRIP_UNLIKELYS |
                this.FLAG_WEIGHT_CLASSES |
                this.FLAG_CLEAN_CONDITIONALLY;


  // Control whether log messages are sent to the console
  if (this._debug) {
    let logNode = function(node) {
      if (node.nodeType == node.TEXT_NODE) {
        return `${node.nodeName} ("${node.textContent}")`;
      }
      let attrPairs = Array.from(node.attributes || [], function(attr) {
        return `${attr.name}="${attr.value}"`;
      }).join(" ");
      return `<${node.localName} ${attrPairs}>`;
    };
    this.log = function () {
      if (typeof console !== "undefined") {
        let args = Array.from(arguments, arg => {
          if (arg && arg.nodeType == this.ELEMENT_NODE) {
            return logNode(arg);
          }
          return arg;
        });
        args.unshift("Reader: (Readability)");
        console.log.apply(console, args);
      } else if (typeof dump !== "undefined") {
        /* global dump */
        var msg = Array.prototype.map.call(arguments, function(x) {
          return (x && x.nodeName) ? logNode(x) : x;
        }).join(" ");
        dump("Reader: (Readability) " + msg + "\n");
      }
    };
  } else {
    this.log = function () {};
  }
}

Readability.prototype = {
  FLAG_STRIP_UNLIKELYS: 0x1,
  FLAG_WEIGHT_CLASSES: 0x2,
  FLAG_CLEAN_CONDITIONALLY: 0x4,

  // https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,

  // Max number of nodes supported by this parser. Default: 0 (no limit)
  DEFAULT_MAX_ELEMS_TO_PARSE: 0,

  // The number of top candidates to consider when analysing how
  // tight the competition is among candidates.
  DEFAULT_N_TOP_CANDIDATES: 5,

  // Element tags to score by default.
  DEFAULT_TAGS_TO_SCORE: "section,h2,h3,h4,h5,h6,p,td,pre".toUpperCase().split(","),

  // The default number of chars an article must have in order to return a result
  DEFAULT_CHAR_THRESHOLD: 500,

  // All of the regular expressions in use within readability.
  // Defined up here so we don't instantiate them repeatedly in loops.
  REGEXPS: {
    // NOTE: These two regular expressions are duplicated in
    // Readability-readerable.js. Please keep both copies in sync.
    unlikelyCandidates: /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybeItsACandidate: /and|article|body|column|content|main|shadow/i,

    positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative: /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|foot|footer|footnote|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget/i,
    extraneous: /print|archive|comment|discuss|e[\-]?mail|share|reply|all|login|sign|single|utility/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    replaceFonts: /<(\/?)font[^>]*>/gi,
    normalize: /\s{2,}/g,
    videos: /\/\/(www\.)?((dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq)\.com|(archive|upload\.wikimedia)\.org|player\.twitch\.tv)/i,
    shareElements: /(\b|_)(share|sharedaddy)(\b|_)/i,
    nextLink: /(next|weiter|continue|>([^\|]|$)|»([^\|]|$))/i,
    prevLink: /(prev|earl|old|new|<|«)/i,
    tokenize: /\W+/g,
    whitespace: /^\s*$/,
    hasContent: /\S$/,
    hashUrl: /^#.+/,
    srcsetUrl: /(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g,
    b64DataUrl: /^data:\s*([^\s;,]+)\s*;\s*base64\s*,/i,
    // Commas as used in Latin, Sindhi, Chinese and various other scripts.
    // see: https://en.wikipedia.org/wiki/Comma#Comma_variants
    commas: /\u002C|\u060C|\uFE50|\uFE10|\uFE11|\u2E41|\u2E34|\u2E32|\uFF0C/g,
    // See: https://schema.org/Article
    jsonLdArticleTypes: /^Article|AdvertiserContentArticle|NewsArticle|AnalysisNewsArticle|AskPublicNewsArticle|BackgroundNewsArticle|OpinionNewsArticle|ReportageNewsArticle|ReviewNewsArticle|Report|SatiricalArticle|ScholarlyArticle|MedicalScholarlyArticle|SocialMediaPosting|BlogPosting|LiveBlogPosting|DiscussionForumPosting|TechArticle|APIReference$/
  },

  UNLIKELY_ROLES: [ "menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog" ],

  DIV_TO_P_ELEMS: new Set([ "BLOCKQUOTE", "DL", "DIV", "IMG", "OL", "P", "PRE", "TABLE", "UL" ]),

  ALTER_TO_DIV_EXCEPTIONS: ["DIV", "ARTICLE", "SECTION", "P"],

  PRESENTATIONAL_ATTRIBUTES: [ "align", "background", "bgcolor", "border", "cellpadding", "cellspacing", "frame", "hspace", "rules", "style", "valign", "vspace" ],

  DEPRECATED_SIZE_ATTRIBUTE_ELEMS: [ "TABLE", "TH", "TD", "HR", "PRE" ],

  // The commented out elements qualify as phrasing content but tend to be
  // removed by readability when put into paragraphs, so we ignore them here.
  PHRASING_ELEMS: [
    // "CANVAS", "IFRAME", "SVG", "VIDEO",
    "ABBR", "AUDIO", "B", "BDO", "BR", "BUTTON", "CITE", "CODE", "DATA",
    "DATALIST", "DFN", "EM", "EMBED", "I", "IMG", "INPUT", "KBD", "LABEL",
    "MARK", "MATH", "METER", "NOSCRIPT", "OBJECT", "OUTPUT", "PROGRESS", "Q",
    "RUBY", "SAMP", "SCRIPT", "SELECT", "SMALL", "SPAN", "STRONG", "SUB",
    "SUP", "TEXTAREA", "TIME", "VAR", "WBR"
  ],

  // These are the classes that readability sets itself.
  CLASSES_TO_PRESERVE: [ "page" ],

  // These are the list of HTML entities that need to be escaped.
  HTML_ESCAPE_MAP: {
    "lt": "<",
    "gt": ">",
    "amp": "&",
    "quot": '"',
    "apos": "'",
  },

  /**
   * Run any post-process modifications to article content as necessary.
   *
   * @param Element
   * @return void
  **/
  _postProcessContent: function(articleContent) {
    // Readability cannot open relative uris so we convert them to absolute uris.
    this._fixRelativeUris(articleContent);

    this._simplifyNestedElements(articleContent);

    if (!this._keepClasses) {
      // Remove classes.
      this._cleanClasses(articleContent);
    }
  },

  /**
   * Iterates over a NodeList, calls `filterFn` for each node and removes node
   * if function returned `true`.
   *
   * If function is not passed, removes all the nodes in node list.
   *
   * @param NodeList nodeList The nodes to operate on
   * @param Function filterFn the function to use as a filter
   * @return void
   */
  _removeNodes: function(nodeList, filterFn) {
    // Avoid ever operating on live node lists.
    if (this._docJSDOMParser && nodeList._isLiveNodeList) {
      throw new Error("Do not pass live node lists to _removeNodes");
    }
    for (var i = nodeList.length - 1; i >= 0; i--) {
      var node = nodeList[i];
      var parentNode = node.parentNode;
      if (parentNode) {
        if (!filterFn || filterFn.call(this, node, i, nodeList)) {
          parentNode.removeChild(node);
        }
      }
    }
  },

  /**
   * Iterates over a NodeList, and calls _setNodeTag for each node.
   *
   * @param NodeList nodeList The nodes to operate on
   * @param String newTagName the new tag name to use
   * @return void
   */
  _replaceNodeTags: function(nodeList, newTagName) {
    // Avoid ever operating on live node lists.
    if (this._docJSDOMParser && nodeList._isLiveNodeList) {
      throw new Error("Do not pass live node lists to _replaceNodeTags");
    }
    for (const node of nodeList) {
      this._setNodeTag(node, newTagName);
    }
  },

  /**
   * Iterate over a NodeList, which doesn't natively fully implement the Array
   * interface.
   *
   * For convenience, the current object context is applied to the provided
   * iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return void
   */
  _forEachNode: function(nodeList, fn) {
    Array.prototype.forEach.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, and return the first node that passes
   * the supplied test function
   *
   * For convenience, the current object context is applied to the provided
   * test function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The test function.
   * @return void
   */
  _findNode: function(nodeList, fn) {
    return Array.prototype.find.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, return true if any of the provided iterate
   * function calls returns true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
  _someNode: function(nodeList, fn) {
    return Array.prototype.some.call(nodeList, fn, this);
  },

  /**
   * Iterate over a NodeList, return true if all of the provided iterate
   * function calls return true, false otherwise.
   *
   * For convenience, the current object context is applied to the
   * provided iterate function.
   *
   * @param  NodeList nodeList The NodeList.
   * @param  Function fn       The iterate function.
   * @return Boolean
   */
  _everyNode: function(nodeList, fn) {
    return Array.prototype.every.call(nodeList, fn, this);
  },

  /**
   * Concat all nodelists passed as arguments.
   *
   * @return ...NodeList
   * @return Array
   */
  _concatNodeLists: function() {
    var slice = Array.prototype.slice;
    var args = slice.call(arguments);
    var nodeLists = args.map(function(list) {
      return slice.call(list);
    });
    return Array.prototype.concat.apply([], nodeLists);
  },

  _getAllNodesWithTag: function(node, tagNames) {
    if (node.querySelectorAll) {
      return node.querySelectorAll(tagNames.join(","));
    }
    return [].concat.apply([], tagNames.map(function(tag) {
      var collection = node.getElementsByTagName(tag);
      return Array.isArray(collection) ? collection : Array.from(collection);
    }));
  },

  /**
   * Removes the class="" attribute from every element in the given
   * subtree, except those that match CLASSES_TO_PRESERVE and
   * the classesToPreserve array from the options object.
   *
   * @param Element
   * @return void
   */
  _cleanClasses: function(node) {
    var classesToPreserve = this._classesToPreserve;
    var className = (node.getAttribute("class") || "")
      .split(/\s+/)
      .filter(function(cls) {
        return classesToPreserve.indexOf(cls) != -1;
      })
      .join(" ");

    if (className) {
      node.setAttribute("class", className);
    } else {
      node.removeAttribute("class");
    }

    for (node = node.firstElementChild; node; node = node.nextElementSibling) {
      this._cleanClasses(node);
    }
  },

  /**
   * Converts each <a> and <img> uri in the given element to an absolute URI,
   * ignoring #ref URIs.
   *
   * @param Element
   * @return void
   */
  _fixRelativeUris: function(articleContent) {
    var baseURI = this._doc.baseURI;
    var documentURI = this._doc.documentURI;
    function toAbsoluteURI(uri) {
      // Leave hash links alone if the base URI matches the document URI:
      if (baseURI == documentURI && uri.charAt(0) == "#") {
        return uri;
      }

      // Otherwise, resolve against base URI:
      try {
        return new URL(uri, baseURI).href;
      } catch (ex) {
        // Something went wrong, just return the original:
      }
      return uri;
    }

    var links = this._getAllNodesWithTag(articleContent, ["a"]);
    this._forEachNode(links, function(link) {
      var href = link.getAttribute("href");
      if (href) {
        // Remove links with javascript: URIs, since
        // they won't work after scripts have been removed from the page.
        if (href.indexOf("javascript:") === 0) {
          // if the link only contains simple text content, it can be converted to a text node
          if (link.childNodes.length === 1 && link.childNodes[0].nodeType === this.TEXT_NODE) {
            var text = this._doc.createTextNode(link.textContent);
            link.parentNode.replaceChild(text, link);
          } else {
            // if the link has multiple children, they should all be preserved
            var container = this._doc.createElement("span");
            while (link.firstChild) {
              container.appendChild(link.firstChild);
            }
            link.parentNode.replaceChild(container, link);
          }
        } else {
          link.setAttribute("href", toAbsoluteURI(href));
        }
      }
    });

    var medias = this._getAllNodesWithTag(articleContent, [
      "img", "picture", "figure", "video", "audio", "source"
    ]);

    this._forEachNode(medias, function(media) {
      var src = media.getAttribute("src");
      var poster = media.getAttribute("poster");
      var srcset = media.getAttribute("srcset");

      if (src) {
        media.setAttribute("src", toAbsoluteURI(src));
      }

      if (poster) {
        media.setAttribute("poster", toAbsoluteURI(poster));
      }

      if (srcset) {
        var newSrcset = srcset.replace(this.REGEXPS.srcsetUrl, function(_, p1, p2, p3) {
          return toAbsoluteURI(p1) + (p2 || "") + p3;
        });

        media.setAttribute("srcset", newSrcset);
      }
    });
  },

  _simplifyNestedElements: function(articleContent) {
    var node = articleContent;

    while (node) {
      if (node.parentNode && ["DIV", "SECTION"].includes(node.tagName) && !(node.id && node.id.startsWith("readability"))) {
        if (this._isElementWithoutContent(node)) {
          node = this._removeAndGetNext(node);
          continue;
        } else if (this._hasSingleTagInsideElement(node, "DIV") || this._hasSingleTagInsideElement(node, "SECTION")) {
          var child = node.children[0];
          for (var i = 0; i < node.attributes.length; i++) {
            child.setAttribute(node.attributes[i].name, node.attributes[i].value);
          }
          node.parentNode.replaceChild(child, node);
          node = child;
          continue;
        }
      }

      node = this._getNextNode(node);
    }
  },

  /**
   * Get the article title as an H1.
   *
   * @return string
   **/
  _getArticleTitle: function() {
    var doc = this._doc;
    var curTitle = "";
    var origTitle = "";

    try {
      curTitle = origTitle = doc.title.trim();

      // If they had an element with id "title" in their HTML
      if (typeof curTitle !== "string")
        curTitle = origTitle = this._getInnerText(doc.getElementsByTagName("title")[0]);
    } catch (e) {/* ignore exceptions setting the title. */}

    var titleHadHierarchicalSeparators = false;
    function wordCount(str) {
      return str.split(/\s+/).length;
    }

    // If there's a separator in the title, first remove the final part
    if ((/ [\|\-\\\/>»] /).test(curTitle)) {
      titleHadHierarchicalSeparators = / [\\\/>»] /.test(curTitle);
      curTitle = origTitle.replace(/(.*)[\|\-\\\/>»] .*/gi, "$1");

      // If the resulting title is too short (3 words or fewer), remove
      // the first part instead:
      if (wordCount(curTitle) < 3)
        curTitle = origTitle.replace(/[^\|\-\\\/>»]*[\|\-\\\/>»](.*)/gi, "$1");
    } else if (curTitle.indexOf(": ") !== -1) {
      // Check if we have an heading containing this exact string, so we
      // could assume it's the full title.
      var headings = this._concatNodeLists(
        doc.getElementsByTagName("h1"),
        doc.getElementsByTagName("h2")
      );
      var trimmedTitle = curTitle.trim();
      var match = this._someNode(headings, function(heading) {
        return heading.textContent.trim() === trimmedTitle;
      });

      // If we don't, let's extract the title out of the original title string.
      if (!match) {
        curTitle = origTitle.substring(origTitle.lastIndexOf(":") + 1);

        // If the title is now too short, try the first colon instead:
        if (wordCount(curTitle) < 3) {
          curTitle = origTitle.substring(origTitle.indexOf(":") + 1);
          // But if we have too many words before the colon there's something weird
          // with the titles and the H tags so let's just use the original title instead
        } else if (wordCount(origTitle.substr(0, origTitle.indexOf(":"))) > 5) {
          curTitle = origTitle;
        }
      }
    } else if (curTitle.length > 150 || curTitle.length < 15) {
      var hOnes = doc.getElementsByTagName("h1");

      if (hOnes.length === 1)
        curTitle = this._getInnerText(hOnes[0]);
    }

    curTitle = curTitle.trim().replace(this.REGEXPS.normalize, " ");
    // If we now have 4 words or fewer as our title, and either no
    // 'hierarchical' separators (\, /, > or ») were found in the original
    // title or we decreased the number of words by more than 1 word, use
    // the original title.
    var curTitleWordCount = wordCount(curTitle);
    if (curTitleWordCount <= 4 &&
        (!titleHadHierarchicalSeparators ||
         curTitleWordCount != wordCount(origTitle.replace(/[\|\-\\\/>»]+/g, "")) - 1)) {
      curTitle = origTitle;
    }

    return curTitle;
  },

  /**
   * Prepare the HTML document for readability to scrape it.
   * This includes things like stripping javascript, CSS, and handling terrible markup.
   *
   * @return void
   **/
  _prepDocument: function() {
    var doc = this._doc;

    // Remove all style tags in head
    this._removeNodes(this._getAllNodesWithTag(doc, ["style"]));

    if (doc.body) {
      this._replaceBrs(doc.body);
    }

    this._replaceNodeTags(this._getAllNodesWithTag(doc, ["font"]), "SPAN");
  },

  /**
   * Finds the next node, starting from the given node, and ignoring
   * whitespace in between. If the given node is an element, the same node is
   * returned.
   */
  _nextNode: function (node) {
    var next = node;
    while (next
        && (next.nodeType != this.ELEMENT_NODE)
        && this.REGEXPS.whitespace.test(next.textContent)) {
      next = next.nextSibling;
    }
    return next;
  },

  /**
   * Replaces 2 or more successive <br> elements with a single <p>.
   * Whitespace between <br> elements are ignored. For example:
   *   <div>foo<br>bar<br> <br><br>abc</div>
   * will become:
   *   <div>foo<br>bar<p>abc</p></div>
   */
  _replaceBrs: function (elem) {
    this._forEachNode(this._getAllNodesWithTag(elem, ["br"]), function(br) {
      var next = br.nextSibling;

      // Whether 2 or more <br> elements have been found and replaced with a
      // <p> block.
      var replaced = false;

      // If we find a <br> chain, remove the <br>s until we hit another node
      // or non-whitespace. This leaves behind the first <br> in the chain
      // (which will be replaced with a <p> later).
      while ((next = this._nextNode(next)) && (next.tagName == "BR")) {
        replaced = true;
        var brSibling = next.nextSibling;
        next.parentNode.removeChild(next);
        next = brSibling;
      }

      // If we removed a <br> chain, replace the remaining <br> with a <p>. Add
      // all sibling nodes as children of the <p> until we hit another <br>
      // chain.
      if (replaced) {
        var p = this._doc.createElement("p");
        br.parentNode.replaceChild(p, br);

        next = p.nextSibling;
        while (next) {
          // If we've hit another <br><br>, we're done adding children to this <p>.
          if (next.tagName == "BR") {
            var nextElem = this._nextNode(next.nextSibling);
            if (nextElem && nextElem.tagName == "BR")
              break;
          }

          if (!this._isPhrasingContent(next))
            break;

          // Otherwise, make this node a child of the new <p>.
          var sibling = next.nextSibling;
          p.appendChild(next);
          next = sibling;
        }

        while (p.lastChild && this._isWhitespace(p.lastChild)) {
          p.removeChild(p.lastChild);
        }

        if (p.parentNode.tagName === "P")
          this._setNodeTag(p.parentNode, "DIV");
      }
    });
  },

  _setNodeTag: function (node, tag) {
    this.log("_setNodeTag", node, tag);
    if (this._docJSDOMParser) {
      node.localName = tag.toLowerCase();
      node.tagName = tag.toUpperCase();
      return node;
    }

    var replacement = node.ownerDocument.createElement(tag);
    while (node.firstChild) {
      replacement.appendChild(node.firstChild);
    }
    node.parentNode.replaceChild(replacement, node);
    if (node.readability)
      replacement.readability = node.readability;

    for (var i = 0; i < node.attributes.length; i++) {
      try {
        replacement.setAttribute(node.attributes[i].name, node.attributes[i].value);
      } catch (ex) {
        /* it's possible for setAttribute() to throw if the attribute name
         * isn't a valid XML Name. Such attributes can however be parsed from
         * source in HTML docs, see https://github.com/whatwg/html/issues/4275,
         * so we can hit them here and then throw. We don't care about such
         * attributes so we ignore them.
         */
      }
    }
    return replacement;
  },

  /**
   * Prepare the article node for display. Clean out any inline styles,
   * iframes, forms, strip extraneous <p> tags, etc.
   *
   * @param Element
   * @return void
   **/
  _prepArticle: function(articleContent) {
    this._cleanStyles(articleContent);

    // Check for data tables before we continue, to avoid removing items in
    // those tables, which will often be isolated even though they're
    // visually linked to other content-ful elements (text, images, etc.).
    this._markDataTables(articleContent);

    this._fixLazyImages(articleContent);

    // Clean out junk from the article content
    this._cleanConditionally(articleContent, "form");
    this._cleanConditionally(articleContent, "fieldset");
    this._clean(articleContent, "object");
    this._clean(articleContent, "embed");
    this._clean(articleContent, "footer");
    this._clean(articleContent, "link");
    this._clean(articleContent, "aside");

    // Clean out elements with little content that have "share" in their id/class combinations from final top candidates,
    // which means we don't remove the top candidates even they have "share".

    var shareElementThreshold = this.DEFAULT_CHAR_THRESHOLD;

    this._forEachNode(articleContent.children, function (topCandidate) {
      this._cleanMatchedNodes(topCandidate, function (node, matchString) {
        return this.REGEXPS.shareElements.test(matchString) && node.textContent.length < shareElementThreshold;
      });
    });

    this._clean(articleContent, "iframe");
    this._clean(articleContent, "input");
    this._clean(articleContent, "textarea");
    this._clean(articleContent, "select");
    this._clean(articleContent, "button");
    this._cleanHeaders(articleContent);

    // Do these last as the previous stuff may have removed junk
    // that will affect these
    this._cleanConditionally(articleContent, "table");
    this._cleanConditionally(articleContent, "ul");
    this._cleanConditionally(articleContent, "div");

    // replace H1 with H2 as H1 should be only title that is displayed separately
    this._replaceNodeTags(this._getAllNodesWithTag(articleContent, ["h1"]), "h2");

    // Remove extra paragraphs
    this._removeNodes(this._getAllNodesWithTag(articleContent, ["p"]), function (paragraph) {
      var imgCount = paragraph.getElementsByTagName("img").length;
      var embedCount = paragraph.getElementsByTagName("embed").length;
      var objectCount = paragraph.getElementsByTagName("object").length;
      // At this point, nasty iframes have been removed, only remain embedded video ones.
      var iframeCount = paragraph.getElementsByTagName("iframe").length;
      var totalCount = imgCount + embedCount + objectCount + iframeCount;

      return totalCount === 0 && !this._getInnerText(paragraph, false);
    });

    this._forEachNode(this._getAllNodesWithTag(articleContent, ["br"]), function(br) {
      var next = this._nextNode(br.nextSibling);
      if (next && next.tagName == "P")
        br.parentNode.removeChild(br);
    });

    // Remove single-cell tables
    this._forEachNode(this._getAllNodesWithTag(articleContent, ["table"]), function(table) {
      var tbody = this._hasSingleTagInsideElement(table, "TBODY") ? table.firstElementChild : table;
      if (this._hasSingleTagInsideElement(tbody, "TR")) {
        var row = tbody.firstElementChild;
        if (this._hasSingleTagInsideElement(row, "TD")) {
          var cell = row.firstElementChild;
          cell = this._setNodeTag(cell, this._everyNode(cell.childNodes, this._isPhrasingContent) ? "P" : "DIV");
          table.parentNode.replaceChild(cell, table);
        }
      }
    });
  },

  /**
   * Initialize a node with the readability object. Also checks the
   * className/id for special names to add to its score.
   *
   * @param Element
   * @return void
  **/
  _initializeNode: function(node) {
    node.readability = {"contentScore": 0};

    switch (node.tagName) {
      case "DIV":
        node.readability.contentScore += 5;
        break;

      case "PRE":
      case "TD":
      case "BLOCKQUOTE":
        node.readability.contentScore += 3;
        break;

      case "ADDRESS":
      case "OL":
      case "UL":
      case "DL":
      case "DD":
      case "DT":
      case "LI":
      case "FORM":
        node.readability.contentScore -= 3;
        break;

      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
      case "TH":
        node.readability.contentScore -= 5;
        break;
    }

    node.readability.contentScore += this._getClassWeight(node);
  },

  _removeAndGetNext: function(node) {
    var nextNode = this._getNextNode(node, true);
    node.parentNode.removeChild(node);
    return nextNode;
  },

  /**
   * Traverse the DOM from node to node, starting at the node passed in.
   * Pass true for the second parameter to indicate this node itself
   * (and its kids) are going away, and we want the next node over.
   *
   * Calling this in a loop will traverse the DOM depth-first.
   */
  _getNextNode: function(node, ignoreSelfAndKids) {
    // First check for kids if those aren't being ignored
    if (!ignoreSelfAndKids && node.firstElementChild) {
      return node.firstElementChild;
    }
    // Then for siblings...
    if (node.nextElementSibling) {
      return node.nextElementSibling;
    }
    // And finally, move up the parent chain *and* find a sibling
    // (because this is depth-first traversal, we will have already
    // seen the parent nodes themselves).
    do {
      node = node.parentNode;
    } while (node && !node.nextElementSibling);
    return node && node.nextElementSibling;
  },

  // compares second text to first one
  // 1 = same text, 0 = completely different text
  // works the way that it splits both texts into words and then finds words that are unique in second text
  // the result is given by the lower length of unique parts
  _textSimilarity: function(textA, textB) {
    var tokensA = textA.toLowerCase().split(this.REGEXPS.tokenize).filter(Boolean);
    var tokensB = textB.toLowerCase().split(this.REGEXPS.tokenize).filter(Boolean);
    if (!tokensA.length || !tokensB.length) {
      return 0;
    }
    var uniqTokensB = tokensB.filter(token => !tokensA.includes(token));
    var distanceB = uniqTokensB.join(" ").length / tokensB.join(" ").length;
    return 1 - distanceB;
  },

  _checkByline: function(node, matchString) {
    if (this._articleByline) {
      return false;
    }

    if (node.getAttribute !== undefined) {
      var rel = node.getAttribute("rel");
      var itemprop = node.getAttribute("itemprop");
    }

    if ((rel === "author" || (itemprop && itemprop.indexOf("author") !== -1) || this.REGEXPS.byline.test(matchString)) && this._isValidByline(node.textContent)) {
      this._articleByline = node.textContent.trim();
      return true;
    }

    return false;
  },

  _getNodeAncestors: function(node, maxDepth) {
    maxDepth = maxDepth || 0;
    var i = 0, ancestors = [];
    while (node.parentNode) {
      ancestors.push(node.parentNode);
      if (maxDepth && ++i === maxDepth)
        break;
      node = node.parentNode;
    }
    return ancestors;
  },

  /***
   * grabArticle - Using a variety of metrics (content score, classname, element types), find the content that is
   *         most likely to be the stuff a user wants to read. Then return it wrapped up in a div.
   *
   * @param page a document to run upon. Needs to be a full document, complete with body.
   * @return Element
  **/
  _grabArticle: function (page) {
    this.log("**** grabArticle ****");
    var doc = this._doc;
    var isPaging = page !== null;
    page = page ? page : this._doc.body;

    // We can't grab an article if we don't have a page!
    if (!page) {
      this.log("No body found in document. Abort.");
      return null;
    }

    var pageCacheHtml = page.innerHTML;

    while (true) {
      this.log("Starting grabArticle loop");
      var stripUnlikelyCandidates = this._flagIsActive(this.FLAG_STRIP_UNLIKELYS);

      // First, node prepping. Trash nodes that look cruddy (like ones with the
      // class name "comment", etc), and turn divs into P tags where they have been
      // used inappropriately (as in, where they contain no other block level elements.)
      var elementsToScore = [];
      var node = this._doc.documentElement;

      let shouldRemoveTitleHeader = true;

      while (node) {

        if (node.tagName === "HTML") {
          this._articleLang = node.getAttribute("lang");
        }

        var matchString = node.className + " " + node.id;

        if (!this._isProbablyVisible(node)) {
          this.log("Removing hidden node - " + matchString);
          node = this._removeAndGetNext(node);
          continue;
        }

        // User is not able to see elements applied with both "aria-modal = true" and "role = dialog"
        if (node.getAttribute("aria-modal") == "true" && node.getAttribute("role") == "dialog") {
          node = this._removeAndGetNext(node);
          continue;
        }

        // Check to see if this node is a byline, and remove it if it is.
        if (this._checkByline(node, matchString)) {
          node = this._removeAndGetNext(node);
          continue;
        }

        if (shouldRemoveTitleHeader && this._headerDuplicatesTitle(node)) {
          this.log("Removing header: ", node.textContent.trim(), this._articleTitle.trim());
          shouldRemoveTitleHeader = false;
          node = this._removeAndGetNext(node);
          continue;
        }

        // Remove unlikely candidates
        if (stripUnlikelyCandidates) {
          if (this.REGEXPS.unlikelyCandidates.test(matchString) &&
              !this.REGEXPS.okMaybeItsACandidate.test(matchString) &&
              !this._hasAncestorTag(node, "table") &&
              !this._hasAncestorTag(node, "code") &&
              node.tagName !== "BODY" &&
              node.tagName !== "A") {
            this.log("Removing unlikely candidate - " + matchString);
            node = this._removeAndGetNext(node);
            continue;
          }

          if (this.UNLIKELY_ROLES.includes(node.getAttribute("role"))) {
            this.log("Removing content with role " + node.getAttribute("role") + " - " + matchString);
            node = this._removeAndGetNext(node);
            continue;
          }
        }

        // Remove DIV, SECTION, and HEADER nodes without any content(e.g. text, image, video, or iframe).
        if ((node.tagName === "DIV" || node.tagName === "SECTION" || node.tagName === "HEADER" ||
             node.tagName === "H1" || node.tagName === "H2" || node.tagName === "H3" ||
             node.tagName === "H4" || node.tagName === "H5" || node.tagName === "H6") &&
            this._isElementWithoutContent(node)) {
          node = this._removeAndGetNext(node);
          continue;
        }

        if (this.DEFAULT_TAGS_TO_SCORE.indexOf(node.tagName) !== -1) {
          elementsToScore.push(node);
        }

        // Turn all divs that don't have children block level elements into p's
        if (node.tagName === "DIV") {
          // Put phrasing content into paragraphs.
          var p = null;
          var childNode = node.firstChild;
          while (childNode) {
            var nextSibling = childNode.nextSibling;
            if (this._isPhrasingContent(childNode)) {
              if (p !== null) {
                p.appendChild(childNode);
              } else if (!this._isWhitespace(childNode)) {
                p = doc.createElement("p");
                node.replaceChild(p, childNode);
                p.appendChild(childNode);
              }
            } else if (p !== null) {
              while (p.lastChild && this._isWhitespace(p.lastChild)) {
                p.removeChild(p.lastChild);
              }
              p = null;
            }
            childNode = nextSibling;
          }

          // Sites like http://mobile.slate.com encloses each paragraph with a DIV
          // element. DIVs with only a P element inside and no text content can be
          // safely converted into plain P elements to avoid confusing the scoring
          // algorithm with DIVs with are, in practice, paragraphs.
          if (this._hasSingleTagInsideElement(node, "P") && this._getLinkDensity(node) < 0.25) {
            var newNode = node.children[0];
            node.parentNode.replaceChild(newNode, node);
            node = newNode;
            elementsToScore.push(node);
          } else if (!this._hasChildBlockElement(node)) {
            node = this._setNodeTag(node, "P");
            elementsToScore.push(node);
          }
        }
        node = this._getNextNode(node);
      }

      /**
       * Loop through all paragraphs, and assign a score to them based on how content-y they look.
       * Then add their score to their parent node.
       *
       * A score is determined by things like number of commas, class names, etc. Maybe eventually link density.
      **/
      var candidates = [];
      this._forEachNode(elementsToScore, function(elementToScore) {
        if (!elementToScore.parentNode || typeof(elementToScore.parentNode.tagName) === "undefined")
          return;

        // If this paragraph is less than 25 characters, don't even count it.
        var innerText = this._getInnerText(elementToScore);
        if (innerText.length < 25)
          return;

        // Exclude nodes with no ancestor.
        var ancestors = this._getNodeAncestors(elementToScore, 5);
        if (ancestors.length === 0)
          return;

        var contentScore = 0;

        // Add a point for the paragraph itself as a base.
        contentScore += 1;

        // Add points for any commas within this paragraph.
        contentScore += innerText.split(this.REGEXPS.commas).length;

        // For every 100 characters in this paragraph, add another point. Up to 3 points.
        contentScore += Math.min(Math.floor(innerText.length / 100), 3);

        // Initialize and score ancestors.
        this._forEachNode(ancestors, function(ancestor, level) {
          if (!ancestor.tagName || !ancestor.parentNode || typeof(ancestor.parentNode.tagName) === "undefined")
            return;

          if (typeof(ancestor.readability) === "undefined") {
            this._initializeNode(ancestor);
            candidates.push(ancestor);
          }

          // Node score divider:
          // - parent:             1 (no division)
          // - grandparent:        2
          // - great grandparent+: ancestor level * 3
          if (level === 0)
            var scoreDivider = 1;
          else if (level === 1)
            scoreDivider = 2;
          else
            scoreDivider = level * 3;
          ancestor.readability.contentScore += contentScore / scoreDivider;
        });
      });

      // After we've calculated scores, loop through all of the possible
      // candidate nodes we found and find the one with the highest score.
      var topCandidates = [];
      for (var c = 0, cl = candidates.length; c < cl; c += 1) {
        var candidate = candidates[c];

        // Scale the final candidates score based on link density. Good content
        // should have a relatively small link density (5% or less) and be mostly
        // unaffected by this operation.
        var candidateScore = candidate.readability.contentScore * (1 - this._getLinkDensity(candidate));
        candidate.readability.contentScore = candidateScore;

        this.log("Candidate:", candidate, "with score " + candidateScore);

        for (var t = 0; t < this._nbTopCandidates; t++) {
          var aTopCandidate = topCandidates[t];

          if (!aTopCandidate || candidateScore > aTopCandidate.readability.contentScore) {
            topCandidates.splice(t, 0, candidate);
            if (topCandidates.length > this._nbTopCandidates)
              topCandidates.pop();
            break;
          }
        }
      }

      var topCandidate = topCandidates[0] || null;
      var neededToCreateTopCandidate = false;
      var parentOfTopCandidate;

      // If we still have no top candidate, just use the body as a last resort.
      // We also have to copy the body node so it is something we can modify.
      if (topCandidate === null || topCandidate.tagName === "BODY") {
        // Move all of the page's children into topCandidate
        topCandidate = doc.createElement("DIV");
        neededToCreateTopCandidate = true;
        // Move everything (not just elements, also text nodes etc.) into the container
        // so we even include text directly in the body:
        while (page.firstChild) {
          this.log("Moving child out:", page.firstChild);
          topCandidate.appendChild(page.firstChild);
        }

        page.appendChild(topCandidate);

        this._initializeNode(topCandidate);
      } else if (topCandidate) {
        // Find a better top candidate node if it contains (at least three) nodes which belong to `topCandidates` array
        // and whose scores are quite closed with current `topCandidate` node.
        var alternativeCandidateAncestors = [];
        for (var i = 1; i < topCandidates.length; i++) {
          if (topCandidates[i].readability.contentScore / topCandidate.readability.contentScore >= 0.75) {
            alternativeCandidateAncestors.push(this._getNodeAncestors(topCandidates[i]));
          }
        }
        var MINIMUM_TOPCANDIDATES = 3;
        if (alternativeCandidateAncestors.length >= MINIMUM_TOPCANDIDATES) {
          parentOfTopCandidate = topCandidate.parentNode;
          while (parentOfTopCandidate.tagName !== "BODY") {
            var listsContainingThisAncestor = 0;
            for (var ancestorIndex = 0; ancestorIndex < alternativeCandidateAncestors.length && listsContainingThisAncestor < MINIMUM_TOPCANDIDATES; ancestorIndex++) {
              listsContainingThisAncestor += Number(alternativeCandidateAncestors[ancestorIndex].includes(parentOfTopCandidate));
            }
            if (listsContainingThisAncestor >= MINIMUM_TOPCANDIDATES) {
              topCandidate = parentOfTopCandidate;
              break;
            }
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
          }
        }
        if (!topCandidate.readability) {
          this._initializeNode(topCandidate);
        }

        // Because of our bonus system, parents of candidates might have scores
        // themselves. They get half of the node. There won't be nodes with higher
        // scores than our topCandidate, but if we see the score going *up* in the first
        // few steps up the tree, that's a decent sign that there might be more content
        // lurking in other places that we want to unify in. The sibling stuff
        // below does some of that - but only if we've looked high enough up the DOM
        // tree.
        parentOfTopCandidate = topCandidate.parentNode;
        var lastScore = topCandidate.readability.contentScore;
        // The scores shouldn't get too low.
        var scoreThreshold = lastScore / 3;
        while (parentOfTopCandidate.tagName !== "BODY") {
          if (!parentOfTopCandidate.readability) {
            parentOfTopCandidate = parentOfTopCandidate.parentNode;
            continue;
          }
          var parentScore = parentOfTopCandidate.readability.contentScore;
          if (parentScore < scoreThreshold)
            break;
          if (parentScore > lastScore) {
            // Alright! We found a better parent to use.
            topCandidate = parentOfTopCandidate;
            break;
          }
          lastScore = parentOfTopCandidate.readability.contentScore;
          parentOfTopCandidate = parentOfTopCandidate.parentNode;
        }

        // If the top candidate is the only child, use parent instead. This will help sibling
        // joining logic when adjacent content is actually located in parent's sibling node.
        parentOfTopCandidate = topCandidate.parentNode;
        while (parentOfTopCandidate.tagName != "BODY" && parentOfTopCandidate.children.length == 1) {
          topCandidate = parentOfTopCandidate;
          parentOfTopCandidate = topCandidate.parentNode;
        }
        if (!topCandidate.readability) {
          this._initializeNode(topCandidate);
        }
      }

      // Now that we have the top candidate, look through its siblings for content
      // that might also be related. Things like preambles, content split by ads
      // that we removed, etc.
      var articleContent = doc.createElement("DIV");
      if (isPaging)
        articleContent.id = "readability-content";

      var siblingScoreThreshold = Math.max(10, topCandidate.readability.contentScore * 0.2);
      // Keep potential top candidate's parent node to try to get text direction of it later.
      parentOfTopCandidate = topCandidate.parentNode;
      var siblings = parentOfTopCandidate.children;

      for (var s = 0, sl = siblings.length; s < sl; s++) {
        var sibling = siblings[s];
        var append = false;

        this.log("Looking at sibling node:", sibling, sibling.readability ? ("with score " + sibling.readability.contentScore) : "");
        this.log("Sibling has score", sibling.readability ? sibling.readability.contentScore : "Unknown");

        if (sibling === topCandidate) {
          append = true;
        } else {
          var contentBonus = 0;

          // Give a bonus if sibling nodes and top candidates have the example same classname
          if (sibling.className === topCandidate.className && topCandidate.className !== "")
            contentBonus += topCandidate.readability.contentScore * 0.2;

          if (sibling.readability &&
              ((sibling.readability.contentScore + contentBonus) >= siblingScoreThreshold)) {
            append = true;
          } else if (sibling.nodeName === "P") {
            var linkDensity = this._getLinkDensity(sibling);
            var nodeContent = this._getInnerText(sibling);
            var nodeLength = nodeContent.length;

            if (nodeLength > 80 && linkDensity < 0.25) {
              append = true;
            } else if (nodeLength < 80 && nodeLength > 0 && linkDensity === 0 &&
                       nodeContent.search(/\.( |$)/) !== -1) {
              append = true;
            }
          }
        }

        if (append) {
          this.log("Appending node:", sibling);

          if (this.ALTER_TO_DIV_EXCEPTIONS.indexOf(sibling.nodeName) === -1) {
            // We have a node that isn't a common block level element, like a form or td tag.
            // Turn it into a div so it doesn't get filtered out later by accident.
            this.log("Altering sibling:", sibling, "to div.");

            sibling = this._setNodeTag(sibling, "DIV");
          }

          articleContent.appendChild(sibling);
          // Fetch children again to make it compatible
          // with DOM parsers without live collection support.
          siblings = parentOfTopCandidate.children;
          // siblings is a reference to the children array, and
          // sibling is removed from the array when we call appendChild().
          // As a result, we must revisit this index since the nodes
          // have been shifted.
          s -= 1;
          sl -= 1;
        }
      }

      if (this._debug)
        this.log("Article content pre-prep: " + articleContent.innerHTML);
      // So we have all of the content that we need. Now we clean it up for presentation.
      this._prepArticle(articleContent);
      if (this._debug)
        this.log("Article content post-prep: " + articleContent.innerHTML);

      if (neededToCreateTopCandidate) {
        // We already created a fake div thing, and there wouldn't have been any siblings left
        // for the previous loop, so there's no point trying to create a new div, and then
        // move all the children over. Just assign IDs and class names here. No need to append
        // because that already happened anyway.
        topCandidate.id = "readability-page-1";
        topCandidate.className = "page";
      } else {
        var div = doc.createElement("DIV");
        div.id = "readability-page-1";
        div.className = "page";
        while (articleContent.firstChild) {
          div.appendChild(articleContent.firstChild);
        }
        articleContent.appendChild(div);
      }

      if (this._debug)
        this.log("Article content after paging: " + articleContent.innerHTML);

      var parseSuccessful = true;

      // Now that we've gone through the full algorithm, check to see if
      // we got any meaningful content. If we didn't, we may need to re-run
      // grabArticle with different flags set. This gives us a higher likelihood of
      // finding the content, and the sieve approach gives us a higher likelihood of
      // finding the -right- content.
      var textLength = this._getInnerText(articleContent, true).length;
      if (textLength < this._charThreshold) {
        parseSuccessful = false;
        page.innerHTML = pageCacheHtml;

        if (this._flagIsActive(this.FLAG_STRIP_UNLIKELYS)) {
          this._removeFlag(this.FLAG_STRIP_UNLIKELYS);
          this._attempts.push({articleContent: articleContent, textLength: textLength});
        } else if (this._flagIsActive(this.FLAG_WEIGHT_CLASSES)) {
          this._removeFlag(this.FLAG_WEIGHT_CLASSES);
          this._attempts.push({articleContent: articleContent, textLength: textLength});
        } else if (this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY)) {
          this._removeFlag(this.FLAG_CLEAN_CONDITIONALLY);
          this._attempts.push({articleContent: articleContent, textLength: textLength});
        } else {
          this._attempts.push({articleContent: articleContent, textLength: textLength});
          // No luck after removing flags, just return the longest text we found during the different loops
          this._attempts.sort(function (a, b) {
            return b.textLength - a.textLength;
          });

          // But first check if we actually have something
          if (!this._attempts[0].textLength) {
            return null;
          }

          articleContent = this._attempts[0].articleContent;
          parseSuccessful = true;
        }
      }

      if (parseSuccessful) {
        // Find out text direction from ancestors of final top candidate.
        var ancestors = [parentOfTopCandidate, topCandidate].concat(this._getNodeAncestors(parentOfTopCandidate));
        this._someNode(ancestors, function(ancestor) {
          if (!ancestor.tagName)
            return false;
          var articleDir = ancestor.getAttribute("dir");
          if (articleDir) {
            this._articleDir = articleDir;
            return true;
          }
          return false;
        });
        return articleContent;
      }
    }
  },

  /**
   * Check whether the input string could be a byline.
   * This verifies that the input is a string, and that the length
   * is less than 100 chars.
   *
   * @param possibleByline {string} - a string to check whether its a byline.
   * @return Boolean - whether the input string is a byline.
   */
  _isValidByline: function(byline) {
    if (typeof byline == "string" || byline instanceof String) {
      byline = byline.trim();
      return (byline.length > 0) && (byline.length < 100);
    }
    return false;
  },

  /**
   * Converts some of the common HTML entities in string to their corresponding characters.
   *
   * @param str {string} - a string to unescape.
   * @return string without HTML entity.
   */
  _unescapeHtmlEntities: function(str) {
    if (!str) {
      return str;
    }

    var htmlEscapeMap = this.HTML_ESCAPE_MAP;
    return str.replace(/&(quot|amp|apos|lt|gt);/g, function(_, tag) {
      return htmlEscapeMap[tag];
    }).replace(/&#(?:x([0-9a-z]{1,4})|([0-9]{1,4}));/gi, function(_, hex, numStr) {
      var num = parseInt(hex || numStr, hex ? 16 : 10);
      return String.fromCharCode(num);
    });
  },

  /**
   * Try to extract metadata from JSON-LD object.
   * For now, only Schema.org objects of type Article or its subtypes are supported.
   * @return Object with any metadata that could be extracted (possibly none)
   */
  _getJSONLD: function (doc) {
    var scripts = this._getAllNodesWithTag(doc, ["script"]);

    var metadata;

    this._forEachNode(scripts, function(jsonLdElement) {
      if (!metadata && jsonLdElement.getAttribute("type") === "application/ld+json") {
        try {
          // Strip CDATA markers if present
          var content = jsonLdElement.textContent.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "");
          var parsed = JSON.parse(content);
          if (
            !parsed["@context"] ||
            !parsed["@context"].match(/^https?\:\/\/schema\.org$/)
          ) {
            return;
          }

          if (!parsed["@type"] && Array.isArray(parsed["@graph"])) {
            parsed = parsed["@graph"].find(function(it) {
              return (it["@type"] || "").match(
                this.REGEXPS.jsonLdArticleTypes
              );
            });
          }

          if (
            !parsed ||
            !parsed["@type"] ||
            !parsed["@type"].match(this.REGEXPS.jsonLdArticleTypes)
          ) {
            return;
          }

          metadata = {};

          if (typeof parsed.name === "string" && typeof parsed.headline === "string" && parsed.name !== parsed.headline) {
            // we have both name and headline element in the JSON-LD. They should both be the same but some websites like aktualne.cz
            // put their own name into "name" and the article title to "headline" which confuses Readability. So we try to check if either
            // "name" or "headline" closely matches the html title, and if so, use that one. If not, then we use "name" by default.

            var title = this._getArticleTitle();
            var nameMatches = this._textSimilarity(parsed.name, title) > 0.75;
            var headlineMatches = this._textSimilarity(parsed.headline, title) > 0.75;

            if (headlineMatches && !nameMatches) {
              metadata.title = parsed.headline;
            } else {
              metadata.title = parsed.name;
            }
          } else if (typeof parsed.name === "string") {
            metadata.title = parsed.name.trim();
          } else if (typeof parsed.headline === "string") {
            metadata.title = parsed.headline.trim();
          }
          if (parsed.author) {
            if (typeof parsed.author.name === "string") {
              metadata.byline = parsed.author.name.trim();
            } else if (Array.isArray(parsed.author) && parsed.author[0] && typeof parsed.author[0].name === "string") {
              metadata.byline = parsed.author
                .filter(function(author) {
                  return author && typeof author.name === "string";
                })
                .map(function(author) {
                  return author.name.trim();
                })
                .join(", ");
            }
          }
          if (typeof parsed.description === "string") {
            metadata.excerpt = parsed.description.trim();
          }
          if (
            parsed.publisher &&
            typeof parsed.publisher.name === "string"
          ) {
            metadata.siteName = parsed.publisher.name.trim();
          }
          if (typeof parsed.datePublished === "string") {
            metadata.datePublished = parsed.datePublished.trim();
          }
          return;
        } catch (err) {
          this.log(err.message);
        }
      }
    });
    return metadata ? metadata : {};
  },

  /**
   * Attempts to get excerpt and byline metadata for the article.
   *
   * @param {Object} jsonld — object containing any metadata that
   * could be extracted from JSON-LD object.
   *
   * @return Object with optional "excerpt" and "byline" properties
   */
  _getArticleMetadata: function(jsonld) {
    var metadata = {};
    var values = {};
    var metaElements = this._doc.getElementsByTagName("meta");

    // property is a space-separated list of values
    var propertyPattern = /\s*(article|dc|dcterm|og|twitter)\s*:\s*(author|creator|description|published_time|title|site_name)\s*/gi;

    // name is a single value
    var namePattern = /^\s*(?:(dc|dcterm|og|twitter|weibo:(article|webpage))\s*[\.:]\s*)?(author|creator|description|title|site_name)\s*$/i;

    // Find description tags.
    this._forEachNode(metaElements, function(element) {
      var elementName = element.getAttribute("name");
      var elementProperty = element.getAttribute("property");
      var content = element.getAttribute("content");
      if (!content) {
        return;
      }
      var matches = null;
      var name = null;

      if (elementProperty) {
        matches = elementProperty.match(propertyPattern);
        if (matches) {
          // Convert to lowercase, and remove any whitespace
          // so we can match below.
          name = matches[0].toLowerCase().replace(/\s/g, "");
          // multiple authors
          values[name] = content.trim();
        }
      }
      if (!matches && elementName && namePattern.test(elementName)) {
        name = elementName;
        if (content) {
          // Convert to lowercase, remove any whitespace, and convert dots
          // to colons so we can match below.
          name = name.toLowerCase().replace(/\s/g, "").replace(/\./g, ":");
          values[name] = content.trim();
        }
      }
    });

    // get title
    metadata.title = jsonld.title ||
                     values["dc:title"] ||
                     values["dcterm:title"] ||
                     values["og:title"] ||
                     values["weibo:article:title"] ||
                     values["weibo:webpage:title"] ||
                     values["title"] ||
                     values["twitter:title"];

    if (!metadata.title) {
      metadata.title = this._getArticleTitle();
    }

    // get author
    metadata.byline = jsonld.byline ||
                      values["dc:creator"] ||
                      values["dcterm:creator"] ||
                      values["author"];

    // get description
    metadata.excerpt = jsonld.excerpt ||
                       values["dc:description"] ||
                       values["dcterm:description"] ||
                       values["og:description"] ||
                       values["weibo:article:description"] ||
                       values["weibo:webpage:description"] ||
                       values["description"] ||
                       values["twitter:description"];

    // get site name
    metadata.siteName = jsonld.siteName ||
                        values["og:site_name"];

    // get article published time
    metadata.publishedTime = jsonld.datePublished ||
      values["article:published_time"] || null;

    // in many sites the meta value is escaped with HTML entities,
    // so here we need to unescape it
    metadata.title = this._unescapeHtmlEntities(metadata.title);
    metadata.byline = this._unescapeHtmlEntities(metadata.byline);
    metadata.excerpt = this._unescapeHtmlEntities(metadata.excerpt);
    metadata.siteName = this._unescapeHtmlEntities(metadata.siteName);
    metadata.publishedTime = this._unescapeHtmlEntities(metadata.publishedTime);

    return metadata;
  },

  /**
   * Check if node is image, or if node contains exactly only one image
   * whether as a direct child or as its descendants.
   *
   * @param Element
  **/
  _isSingleImage: function(node) {
    if (node.tagName === "IMG") {
      return true;
    }

    if (node.children.length !== 1 || node.textContent.trim() !== "") {
      return false;
    }

    return this._isSingleImage(node.children[0]);
  },

  /**
   * Find all <noscript> that are located after <img> nodes, and which contain only one
   * <img> element. Replace the first image with the image from inside the <noscript> tag,
   * and remove the <noscript> tag. This improves the quality of the images we use on
   * some sites (e.g. Medium).
   *
   * @param Element
  **/
  _unwrapNoscriptImages: function(doc) {
    // Find img without source or attributes that might contains image, and remove it.
    // This is done to prevent a placeholder img is replaced by img from noscript in next step.
    var imgs = Array.from(doc.getElementsByTagName("img"));
    this._forEachNode(imgs, function(img) {
      for (var i = 0; i < img.attributes.length; i++) {
        var attr = img.attributes[i];
        switch (attr.name) {
          case "src":
          case "srcset":
          case "data-src":
          case "data-srcset":
            return;
        }

        if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
          return;
        }
      }

      img.parentNode.removeChild(img);
    });

    // Next find noscript and try to extract its image
    var noscripts = Array.from(doc.getElementsByTagName("noscript"));
    this._forEachNode(noscripts, function(noscript) {
      // Parse content of noscript and make sure it only contains image
      var tmp = doc.createElement("div");
      tmp.innerHTML = noscript.innerHTML;
      if (!this._isSingleImage(tmp)) {
        return;
      }

      // If noscript has previous sibling and it only contains image,
      // replace it with noscript content. However we also keep old
      // attributes that might contains image.
      var prevElement = noscript.previousElementSibling;
      if (prevElement && this._isSingleImage(prevElement)) {
        var prevImg = prevElement;
        if (prevImg.tagName !== "IMG") {
          prevImg = prevElement.getElementsByTagName("img")[0];
        }

        var newImg = tmp.getElementsByTagName("img")[0];
        for (var i = 0; i < prevImg.attributes.length; i++) {
          var attr = prevImg.attributes[i];
          if (attr.value === "") {
            continue;
          }

          if (attr.name === "src" || attr.name === "srcset" || /\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
            if (newImg.getAttribute(attr.name) === attr.value) {
              continue;
            }

            var attrName = attr.name;
            if (newImg.hasAttribute(attrName)) {
              attrName = "data-old-" + attrName;
            }

            newImg.setAttribute(attrName, attr.value);
          }
        }

        noscript.parentNode.replaceChild(tmp.firstElementChild, prevElement);
      }
    });
  },

  /**
   * Removes script tags from the document.
   *
   * @param Element
  **/
  _removeScripts: function(doc) {
    this._removeNodes(this._getAllNodesWithTag(doc, ["script", "noscript"]));
  },

  /**
   * Check if this node has only whitespace and a single element with given tag
   * Returns false if the DIV node contains non-empty text nodes
   * or if it contains no element with given tag or more than 1 element.
   *
   * @param Element
   * @param string tag of child element
  **/
  _hasSingleTagInsideElement: function(element, tag) {
    // There should be exactly 1 element child with given tag
    if (element.children.length != 1 || element.children[0].tagName !== tag) {
      return false;
    }

    // And there should be no text nodes with real content
    return !this._someNode(element.childNodes, function(node) {
      return node.nodeType === this.TEXT_NODE &&
             this.REGEXPS.hasContent.test(node.textContent);
    });
  },

  _isElementWithoutContent: function(node) {
    return node.nodeType === this.ELEMENT_NODE &&
      node.textContent.trim().length == 0 &&
      (node.children.length == 0 ||
       node.children.length == node.getElementsByTagName("br").length + node.getElementsByTagName("hr").length);
  },

  /**
   * Determine whether element has any children block level elements.
   *
   * @param Element
   */
  _hasChildBlockElement: function (element) {
    return this._someNode(element.childNodes, function(node) {
      return this.DIV_TO_P_ELEMS.has(node.tagName) ||
             this._hasChildBlockElement(node);
    });
  },

  /***
   * Determine if a node qualifies as phrasing content.
   * https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/Content_categories#Phrasing_content
  **/
  _isPhrasingContent: function(node) {
    return node.nodeType === this.TEXT_NODE || this.PHRASING_ELEMS.indexOf(node.tagName) !== -1 ||
      ((node.tagName === "A" || node.tagName === "DEL" || node.tagName === "INS") &&
        this._everyNode(node.childNodes, this._isPhrasingContent));
  },

  _isWhitespace: function(node) {
    return (node.nodeType === this.TEXT_NODE && node.textContent.trim().length === 0) ||
           (node.nodeType === this.ELEMENT_NODE && node.tagName === "BR");
  },

  /**
   * Get the inner text of a node - cross browser compatibly.
   * This also strips out any excess whitespace to be found.
   *
   * @param Element
   * @param Boolean normalizeSpaces (default: true)
   * @return string
  **/
  _getInnerText: function(e, normalizeSpaces) {
    normalizeSpaces = (typeof normalizeSpaces === "undefined") ? true : normalizeSpaces;
    var textContent = e.textContent.trim();

    if (normalizeSpaces) {
      return textContent.replace(this.REGEXPS.normalize, " ");
    }
    return textContent;
  },

  /**
   * Get the number of times a string s appears in the node e.
   *
   * @param Element
   * @param string - what to split on. Default is ","
   * @return number (integer)
  **/
  _getCharCount: function(e, s) {
    s = s || ",";
    return this._getInnerText(e).split(s).length - 1;
  },

  /**
   * Remove the style attribute on every e and under.
   * TODO: Test if getElementsByTagName(*) is faster.
   *
   * @param Element
   * @return void
  **/
  _cleanStyles: function(e) {
    if (!e || e.tagName.toLowerCase() === "svg")
      return;

    // Remove `style` and deprecated presentational attributes
    for (var i = 0; i < this.PRESENTATIONAL_ATTRIBUTES.length; i++) {
      e.removeAttribute(this.PRESENTATIONAL_ATTRIBUTES[i]);
    }

    if (this.DEPRECATED_SIZE_ATTRIBUTE_ELEMS.indexOf(e.tagName) !== -1) {
      e.removeAttribute("width");
      e.removeAttribute("height");
    }

    var cur = e.firstElementChild;
    while (cur !== null) {
      this._cleanStyles(cur);
      cur = cur.nextElementSibling;
    }
  },

  /**
   * Get the density of links as a percentage of the content
   * This is the amount of text that is inside a link divided by the total text in the node.
   *
   * @param Element
   * @return number (float)
  **/
  _getLinkDensity: function(element) {
    var textLength = this._getInnerText(element).length;
    if (textLength === 0)
      return 0;

    var linkLength = 0;

    // XXX implement _reduceNodeList?
    this._forEachNode(element.getElementsByTagName("a"), function(linkNode) {
      var href = linkNode.getAttribute("href");
      var coefficient = href && this.REGEXPS.hashUrl.test(href) ? 0.3 : 1;
      linkLength += this._getInnerText(linkNode).length * coefficient;
    });

    return linkLength / textLength;
  },

  /**
   * Get an elements class/id weight. Uses regular expressions to tell if this
   * element looks good or bad.
   *
   * @param Element
   * @return number (Integer)
  **/
  _getClassWeight: function(e) {
    if (!this._flagIsActive(this.FLAG_WEIGHT_CLASSES))
      return 0;

    var weight = 0;

    // Look for a special classname
    if (typeof(e.className) === "string" && e.className !== "") {
      if (this.REGEXPS.negative.test(e.className))
        weight -= 25;

      if (this.REGEXPS.positive.test(e.className))
        weight += 25;
    }

    // Look for a special ID
    if (typeof(e.id) === "string" && e.id !== "") {
      if (this.REGEXPS.negative.test(e.id))
        weight -= 25;

      if (this.REGEXPS.positive.test(e.id))
        weight += 25;
    }

    return weight;
  },

  /**
   * Clean a node of all elements of type "tag".
   * (Unless it's a youtube/vimeo video. People love movies.)
   *
   * @param Element
   * @param string tag to clean
   * @return void
   **/
  _clean: function(e, tag) {
    var isEmbed = ["object", "embed", "iframe"].indexOf(tag) !== -1;

    this._removeNodes(this._getAllNodesWithTag(e, [tag]), function(element) {
      // Allow youtube and vimeo videos through as people usually want to see those.
      if (isEmbed) {
        // First, check the elements attributes to see if any of them contain youtube or vimeo
        for (var i = 0; i < element.attributes.length; i++) {
          if (this._allowedVideoRegex.test(element.attributes[i].value)) {
            return false;
          }
        }

        // For embed with <object> tag, check inner HTML as well.
        if (element.tagName === "object" && this._allowedVideoRegex.test(element.innerHTML)) {
          return false;
        }
      }

      return true;
    });
  },

  /**
   * Check if a given node has one of its ancestor tag name matching the
   * provided one.
   * @param  HTMLElement node
   * @param  String      tagName
   * @param  Number      maxDepth
   * @param  Function    filterFn a filter to invoke to determine whether this node 'counts'
   * @return Boolean
   */
  _hasAncestorTag: function(node, tagName, maxDepth, filterFn) {
    maxDepth = maxDepth || 3;
    tagName = tagName.toUpperCase();
    var depth = 0;
    while (node.parentNode) {
      if (maxDepth > 0 && depth > maxDepth)
        return false;
      if (node.parentNode.tagName === tagName && (!filterFn || filterFn(node.parentNode)))
        return true;
      node = node.parentNode;
      depth++;
    }
    return false;
  },

  /**
   * Return an object indicating how many rows and columns this table has.
   */
  _getRowAndColumnCount: function(table) {
    var rows = 0;
    var columns = 0;
    var trs = table.getElementsByTagName("tr");
    for (var i = 0; i < trs.length; i++) {
      var rowspan = trs[i].getAttribute("rowspan") || 0;
      if (rowspan) {
        rowspan = parseInt(rowspan, 10);
      }
      rows += (rowspan || 1);

      // Now look for column-related info
      var columnsInThisRow = 0;
      var cells = trs[i].getElementsByTagName("td");
      for (var j = 0; j < cells.length; j++) {
        var colspan = cells[j].getAttribute("colspan") || 0;
        if (colspan) {
          colspan = parseInt(colspan, 10);
        }
        columnsInThisRow += (colspan || 1);
      }
      columns = Math.max(columns, columnsInThisRow);
    }
    return {rows: rows, columns: columns};
  },

  /**
   * Look for 'data' (as opposed to 'layout') tables, for which we use
   * similar checks as
   * https://searchfox.org/mozilla-central/rev/f82d5c549f046cb64ce5602bfd894b7ae807c8f8/accessible/generic/TableAccessible.cpp#19
   */
  _markDataTables: function(root) {
    var tables = root.getElementsByTagName("table");
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var role = table.getAttribute("role");
      if (role == "presentation") {
        table._readabilityDataTable = false;
        continue;
      }
      var datatable = table.getAttribute("datatable");
      if (datatable == "0") {
        table._readabilityDataTable = false;
        continue;
      }
      var summary = table.getAttribute("summary");
      if (summary) {
        table._readabilityDataTable = true;
        continue;
      }

      var caption = table.getElementsByTagName("caption")[0];
      if (caption && caption.childNodes.length > 0) {
        table._readabilityDataTable = true;
        continue;
      }

      // If the table has a descendant with any of these tags, consider a data table:
      var dataTableDescendants = ["col", "colgroup", "tfoot", "thead", "th"];
      var descendantExists = function(tag) {
        return !!table.getElementsByTagName(tag)[0];
      };
      if (dataTableDescendants.some(descendantExists)) {
        this.log("Data table because found data-y descendant");
        table._readabilityDataTable = true;
        continue;
      }

      // Nested tables indicate a layout table:
      if (table.getElementsByTagName("table")[0]) {
        table._readabilityDataTable = false;
        continue;
      }

      var sizeInfo = this._getRowAndColumnCount(table);
      if (sizeInfo.rows >= 10 || sizeInfo.columns > 4) {
        table._readabilityDataTable = true;
        continue;
      }
      // Now just go by size entirely:
      table._readabilityDataTable = sizeInfo.rows * sizeInfo.columns > 10;
    }
  },

  /* convert images and figures that have properties like data-src into images that can be loaded without JS */
  _fixLazyImages: function (root) {
    this._forEachNode(this._getAllNodesWithTag(root, ["img", "picture", "figure"]), function (elem) {
      // In some sites (e.g. Kotaku), they put 1px square image as base64 data uri in the src attribute.
      // So, here we check if the data uri is too short, just might as well remove it.
      if (elem.src && this.REGEXPS.b64DataUrl.test(elem.src)) {
        // Make sure it's not SVG, because SVG can have a meaningful image in under 133 bytes.
        var parts = this.REGEXPS.b64DataUrl.exec(elem.src);
        if (parts[1] === "image/svg+xml") {
          return;
        }

        // Make sure this element has other attributes which contains image.
        // If it doesn't, then this src is important and shouldn't be removed.
        var srcCouldBeRemoved = false;
        for (var i = 0; i < elem.attributes.length; i++) {
          var attr = elem.attributes[i];
          if (attr.name === "src") {
            continue;
          }

          if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
            srcCouldBeRemoved = true;
            break;
          }
        }

        // Here we assume if image is less than 100 bytes (or 133B after encoded to base64)
        // it will be too small, therefore it might be placeholder image.
        if (srcCouldBeRemoved) {
          var b64starts = elem.src.search(/base64\s*/i) + 7;
          var b64length = elem.src.length - b64starts;
          if (b64length < 133) {
            elem.removeAttribute("src");
          }
        }
      }

      // also check for "null" to work around https://github.com/jsdom/jsdom/issues/2580
      if ((elem.src || (elem.srcset && elem.srcset != "null")) && elem.className.toLowerCase().indexOf("lazy") === -1) {
        return;
      }

      for (var j = 0; j < elem.attributes.length; j++) {
        attr = elem.attributes[j];
        if (attr.name === "src" || attr.name === "srcset" || attr.name === "alt") {
          continue;
        }
        var copyTo = null;
        if (/\.(jpg|jpeg|png|webp)\s+\d/.test(attr.value)) {
          copyTo = "srcset";
        } else if (/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/.test(attr.value)) {
          copyTo = "src";
        }
        if (copyTo) {
          //if this is an img or picture, set the attribute directly
          if (elem.tagName === "IMG" || elem.tagName === "PICTURE") {
            elem.setAttribute(copyTo, attr.value);
          } else if (elem.tagName === "FIGURE" && !this._getAllNodesWithTag(elem, ["img", "picture"]).length) {
            //if the item is a <figure> that does not contain an image or picture, create one and place it inside the figure
            //see the nytimes-3 testcase for an example
            var img = this._doc.createElement("img");
            img.setAttribute(copyTo, attr.value);
            elem.appendChild(img);
          }
        }
      }
    });
  },

  _getTextDensity: function(e, tags) {
    var textLength = this._getInnerText(e, true).length;
    if (textLength === 0) {
      return 0;
    }
    var childrenLength = 0;
    var children = this._getAllNodesWithTag(e, tags);
    this._forEachNode(children, (child) => childrenLength += this._getInnerText(child, true).length);
    return childrenLength / textLength;
  },

  /**
   * Clean an element of all tags of type "tag" if they look fishy.
   * "Fishy" is an algorithm based on content length, classnames, link density, number of images & embeds, etc.
   *
   * @return void
   **/
  _cleanConditionally: function(e, tag) {
    if (!this._flagIsActive(this.FLAG_CLEAN_CONDITIONALLY))
      return;

    // Gather counts for other typical elements embedded within.
    // Traverse backwards so we can remove nodes at the same time
    // without effecting the traversal.
    //
    // TODO: Consider taking into account original contentScore here.
    this._removeNodes(this._getAllNodesWithTag(e, [tag]), function(node) {
      // First check if this node IS data table, in which case don't remove it.
      var isDataTable = function(t) {
        return t._readabilityDataTable;
      };

      var isList = tag === "ul" || tag === "ol";
      if (!isList) {
        var listLength = 0;
        var listNodes = this._getAllNodesWithTag(node, ["ul", "ol"]);
        this._forEachNode(listNodes, (list) => listLength += this._getInnerText(list).length);
        isList = listLength / this._getInnerText(node).length > 0.9;
      }

      if (tag === "table" && isDataTable(node)) {
        return false;
      }

      // Next check if we're inside a data table, in which case don't remove it as well.
      if (this._hasAncestorTag(node, "table", -1, isDataTable)) {
        return false;
      }

      if (this._hasAncestorTag(node, "code")) {
        return false;
      }

      var weight = this._getClassWeight(node);

      this.log("Cleaning Conditionally", node);

      var contentScore = 0;

      if (weight + contentScore < 0) {
        return true;
      }

      if (this._getCharCount(node, ",") < 10) {
        // If there are not very many commas, and the number of
        // non-paragraph elements is more than paragraphs or other
        // ominous signs, remove the element.
        var p = node.getElementsByTagName("p").length;
        var img = node.getElementsByTagName("img").length;
        var li = node.getElementsByTagName("li").length - 100;
        var input = node.getElementsByTagName("input").length;
        var headingDensity = this._getTextDensity(node, ["h1", "h2", "h3", "h4", "h5", "h6"]);

        var embedCount = 0;
        var embeds = this._getAllNodesWithTag(node, ["object", "embed", "iframe"]);

        for (var i = 0; i < embeds.length; i++) {
          // If this embed has attribute that matches video regex, don't delete it.
          for (var j = 0; j < embeds[i].attributes.length; j++) {
            if (this._allowedVideoRegex.test(embeds[i].attributes[j].value)) {
              return false;
            }
          }

          // For embed with <object> tag, check inner HTML as well.
          if (embeds[i].tagName === "object" && this._allowedVideoRegex.test(embeds[i].innerHTML)) {
            return false;
          }

          embedCount++;
        }

        var linkDensity = this._getLinkDensity(node);
        var contentLength = this._getInnerText(node).length;

        var haveToRemove =
          (img > 1 && p / img < 0.5 && !this._hasAncestorTag(node, "figure")) ||
          (!isList && li > p) ||
          (input > Math.floor(p/3)) ||
          (!isList && headingDensity < 0.9 && contentLength < 25 && (img === 0 || img > 2) && !this._hasAncestorTag(node, "figure")) ||
          (!isList && weight < 25 && linkDensity > 0.2) ||
          (weight >= 25 && linkDensity > 0.5) ||
          ((embedCount === 1 && contentLength < 75) || embedCount > 1);
        // Allow simple lists of images to remain in pages
        if (isList && haveToRemove) {
          for (var x = 0; x < node.children.length; x++) {
            let child = node.children[x];
            // Don't filter in lists with li's that contain more than one child
            if (child.children.length > 1) {
              return haveToRemove;
            }
          }
          let li_count = node.getElementsByTagName("li").length;
          // Only allow the list to remain if every li contains an image
          if (img == li_count) {
            return false;
          }
        }
        return haveToRemove;
      }
      return false;
    });
  },

  /**
   * Clean out elements that match the specified conditions
   *
   * @param Element
   * @param Function determines whether a node should be removed
   * @return void
   **/
  _cleanMatchedNodes: function(e, filter) {
    var endOfSearchMarkerNode = this._getNextNode(e, true);
    var next = this._getNextNode(e);
    while (next && next != endOfSearchMarkerNode) {
      if (filter.call(this, next, next.className + " " + next.id)) {
        next = this._removeAndGetNext(next);
      } else {
        next = this._getNextNode(next);
      }
    }
  },

  /**
   * Clean out spurious headers from an Element.
   *
   * @param Element
   * @return void
  **/
  _cleanHeaders: function(e) {
    let headingNodes = this._getAllNodesWithTag(e, ["h1", "h2"]);
    this._removeNodes(headingNodes, function(node) {
      let shouldRemove = this._getClassWeight(node) < 0;
      if (shouldRemove) {
        this.log("Removing header with low class weight:", node);
      }
      return shouldRemove;
    });
  },

  /**
   * Check if this node is an H1 or H2 element whose content is mostly
   * the same as the article title.
   *
   * @param Element  the node to check.
   * @return boolean indicating whether this is a title-like header.
   */
  _headerDuplicatesTitle: function(node) {
    if (node.tagName != "H1" && node.tagName != "H2") {
      return false;
    }
    var heading = this._getInnerText(node, false);
    this.log("Evaluating similarity of header:", heading, this._articleTitle);
    return this._textSimilarity(this._articleTitle, heading) > 0.75;
  },

  _flagIsActive: function(flag) {
    return (this._flags & flag) > 0;
  },

  _removeFlag: function(flag) {
    this._flags = this._flags & ~flag;
  },

  _isProbablyVisible: function(node) {
    // Have to null-check node.style and node.className.indexOf to deal with SVG and MathML nodes.
    return (!node.style || node.style.display != "none")
      && (!node.style || node.style.visibility != "hidden")
      && !node.hasAttribute("hidden")
      //check for "fallback-image" so that wikimedia math images are displayed
      && (!node.hasAttribute("aria-hidden") || node.getAttribute("aria-hidden") != "true" || (node.className && node.className.indexOf && node.className.indexOf("fallback-image") !== -1));
  },

  /**
   * Runs readability.
   *
   * Workflow:
   *  1. Prep the document by removing script tags, css, etc.
   *  2. Build readability's DOM tree.
   *  3. Grab the article content from the current dom tree.
   *  4. Replace the current DOM tree with the new one.
   *  5. Read peacefully.
   *
   * @return void
   **/
  parse: function () {
    // Avoid parsing too large documents, as per configuration option
    if (this._maxElemsToParse > 0) {
      var numTags = this._doc.getElementsByTagName("*").length;
      if (numTags > this._maxElemsToParse) {
        throw new Error("Aborting parsing document; " + numTags + " elements found");
      }
    }

    // Unwrap image from noscript
    this._unwrapNoscriptImages(this._doc);

    // Extract JSON-LD metadata before removing scripts
    var jsonLd = this._disableJSONLD ? {} : this._getJSONLD(this._doc);

    // Remove script tags from the document.
    this._removeScripts(this._doc);

    this._prepDocument();

    var metadata = this._getArticleMetadata(jsonLd);
    this._articleTitle = metadata.title;

    var articleContent = this._grabArticle();
    if (!articleContent)
      return null;

    this.log("Grabbed: " + articleContent.innerHTML);

    this._postProcessContent(articleContent);

    // If we haven't found an excerpt in the article's metadata, use the article's
    // first paragraph as the excerpt. This is used for displaying a preview of
    // the article's content.
    if (!metadata.excerpt) {
      var paragraphs = articleContent.getElementsByTagName("p");
      if (paragraphs.length > 0) {
        metadata.excerpt = paragraphs[0].textContent.trim();
      }
    }

    var textContent = articleContent.textContent;
    return {
      title: this._articleTitle,
      byline: metadata.byline || this._articleByline,
      dir: this._articleDir,
      lang: this._articleLang,
      content: this._serializer(articleContent),
      textContent: textContent,
      length: textContent.length,
      excerpt: metadata.excerpt,
      siteName: metadata.siteName || this._articleSiteName,
      publishedTime: metadata.publishedTime
    };
  }
};

if (typeof module === "object") {
  /* global module */
  module.exports = Readability;
}
// <<< END READABILITY

  // ---------------------------------------------------------------------------
  // Extractor
  // ---------------------------------------------------------------------------

  const MIN_ARTICLE_CHARS = 500;
  const SHORT_TEXT_CHARS = 400;

  const STRIP_SELECTORS = [
    'script', 'style', 'noscript', 'nav', 'aside', 'footer', 'form', 'iframe',
    'svg', 'canvas', '[aria-hidden="true"]', '.cookie', '.newsletter', '.subscribe',
  ];

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY',
    'TR', 'TD', 'TH', 'FIGCAPTION', 'FIGURE', 'DL', 'DT', 'DD', 'ARTICLE',
  ]);

  function codeLanguage(element) {
    const code = element.querySelector('code') || element;
    const match = String(code.className || '').match(/language-([\w-]+)/);
    return match ? match[1] : '';
  }

  function htmlToPlainText(root) {
    const preBlocks = [];

    function walk(node) {
      if (node.nodeType === 3) {
        return String(node.nodeValue || '').replace(/\s+/g, ' ');
      }
      if (node.nodeType !== 1) return '';

      const tag = node.tagName;

      if (tag === 'PRE') {
        const body = String(node.textContent || '').replace(/^\n+/, '').replace(/\n+$/, '');
        const lang = codeLanguage(node);
        const token = '\u0000PRE' + preBlocks.length + '\u0000';
        preBlocks.push('```' + lang + '\n' + body + '\n```');
        return '\n' + token + '\n';
      }

      if (tag === 'BR') return '\n';
      if (tag === 'HR') return '\n';

      let inner = '';
      node.childNodes.forEach((child) => {
        inner += walk(child);
      });

      if (tag === 'LI') return '\n- ' + inner.replace(/^\s+/, '');

      if (BLOCK_TAGS.has(tag)) return '\n' + inner + '\n';

      return inner;
    }

    let text = walk(root);
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/ *\n */g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/\u0000PRE(\d+)\u0000/g, (match, index) => '\n' + preBlocks[Number(index)] + '\n');

    return text.trim();
  }

  function fallbackContainer(doc) {
    return (
      doc.querySelector('article') ||
      doc.querySelector('main') ||
      doc.querySelector('[role="main"]') ||
      doc.querySelector('[itemprop="articleBody"]') ||
      doc.body
    );
  }

  function extractArticle(doc, opts) {
    const options = Object.assign({ autoExtract: true, maxChars: 60000 }, opts || {});

    const clone = doc.cloneNode(true);
    STRIP_SELECTORS.forEach((selector) => {
      clone.querySelectorAll(selector).forEach((element) => element.remove());
    });

    let container = null;
    let usedReadability = false;

    if (options.autoExtract && typeof Readability === 'function') {
      try {
        const parsed = new Readability(clone, { keepClasses: true }).parse();
        if (parsed && parsed.content) {
          const parsedDoc = new DOMParser().parseFromString(parsed.content, 'text/html');
          if (htmlToPlainText(parsedDoc.body).length >= MIN_ARTICLE_CHARS) {
            container = parsedDoc.body;
            usedReadability = true;
          }
        }
      } catch (error) {
        container = null;
      }
    }

    if (!container) container = fallbackContainer(clone);

    let text = htmlToPlainText(container);
    const originalLength = text.length;
    let truncated = false;

    if (text.length > options.maxChars) {
      const cut = text.lastIndexOf('\n\n', options.maxChars);
      text = cut > 0 ? text.slice(0, cut) : text.slice(0, options.maxChars);
      truncated = true;
    }

    text = text.trim();

    return {
      text,
      originalLength,
      truncated,
      short: text.length < SHORT_TEXT_CHARS,
      usedReadability,
    };
  }

  function buildNote(extracted, autoExtract) {
    if (!extracted) return '';
    if (extracted.truncated) {
      return (
        'Текст обрезан, отправлено ' +
        extracted.text.length +
        ' из ' +
        extracted.originalLength +
        ' символов.'
      );
    }
    if (extracted.short) return 'Похоже, это не статья — текст короткий.';
    if (autoExtract && !extracted.usedReadability) {
      return 'Readability не выделил статью — отправлен текст страницы.';
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Stream and errors
  // ---------------------------------------------------------------------------

  function createSseParser(onPayload) {
    let buffer = '';
    let finished = false;

    function handleLine(rawLine) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim()) return;
      if (line.startsWith(':')) return;
      if (!line.startsWith('data:')) return;

      let data = line.slice(5);
      if (data.startsWith(' ')) data = data.slice(1);
      if (data.trim() === '[DONE]') {
        finished = true;
        return;
      }

      try {
        onPayload(JSON.parse(data));
      } catch (error) {
        return;
      }
    }

    function consume(final) {
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (finished) return;
        newlineIndex = buffer.indexOf('\n');
      }

      if (final && buffer.trim()) {
        handleLine(buffer);
        buffer = '';
      }
    }

    return {
      push(chunkText) {
        if (finished) return { done: true };
        buffer += chunkText;
        consume(false);
        return { done: finished };
      },
      flush() {
        if (finished) return { done: true };
        consume(true);
        return { done: finished };
      },
    };
  }

  function extractDelta(payload) {
    const choices = payload && payload.choices;
    if (!choices || !choices[0] || !choices[0].delta) return '';
    const content = choices[0].delta.content;
    return typeof content === 'string' ? content : '';
  }

  function extractUsage(payload) {
    const tokens = payload && payload.usage && payload.usage.completion_tokens;
    return typeof tokens === 'number' && tokens > 0 ? tokens : null;
  }

  function errorMessageOf(bodyText) {
    const text = String(bodyText == null ? '' : bodyText);
    try {
      const parsed = JSON.parse(text);
      const parts = [
        parsed && parsed.error && parsed.error.message,
        parsed && parsed.error && parsed.error.code,
        parsed && parsed.message,
        parsed && parsed.code,
      ].filter((part) => typeof part === 'string' && part.trim());
      if (parts.length > 0) return parts.join(' — ').slice(0, 400);
    } catch (error) {
      return text.trim().slice(0, 400);
    }
    return text.trim().slice(0, 400);
  }

  function parseApiError(status, bodyText) {
    const message = errorMessageOf(bodyText);
    const haystack = message.toLowerCase();

    if (status === 401 || status === 403) {
      return 'Неверный ключ API. Откройте настройки и проверьте ключ.';
    }

    if (status === 402 || status === 429 || /quota|rate.?limit|insufficient|billing/.test(haystack)) {
      return 'Закончились токены или превышен лимит запросов.';
    }

    if (status === 404) {
      return 'Модель или адрес не найдены. Проверьте apiBase и имя модели.';
    }

    if (status === 0) {
      return 'Не удалось связаться с API. Проверьте адрес и доступ к нему из браузера.';
    }

    if (status === 400) {
      return message ? 'Запрос отклонён: ' + message : 'Запрос отклонён сервером.';
    }

    return message ? 'Ошибка API (' + status + '): ' + message : 'Ошибка API (' + status + ').';
  }

  // ---------------------------------------------------------------------------
  // API client
  // ---------------------------------------------------------------------------

  function isDeepSeekEndpoint(apiBase) {
    try {
      const host = new URL(String(apiBase)).hostname;
      return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
    } catch (error) {
      return false;
    }
  }

  function contentToString(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }

  function describeEmptyAnswer(finishReason, reasoningSeen) {
    if (finishReason === 'length') {
      return (
        'Модель израсходовала лимит токенов и не успела выдать ответ. ' +
        'Увеличьте «Макс. токенов» в настройках или отключите режим размышлений.'
      );
    }
    if (finishReason === 'content_filter') {
      return 'Ответ заблокирован фильтром содержимого модели. Попробуйте переформулировать фокус.';
    }
    if (finishReason === 'insufficient_system_resource') {
      return 'Сервис модели не выделил ресурсы под запрос. Повторите позже.';
    }
    if (finishReason === 'aborted') {
      return 'Сервер прервал генерацию. Повторите запрос.';
    }
    if (reasoningSeen) {
      return (
        'Модель потратила весь ответ на размышления и не прислала текст. ' +
        'Увеличьте «Макс. токенов» или отключите режим размышлений в настройках.'
      );
    }
    return 'Модель вернула пустой ответ.';
  }

  function requestCompletion(options) {
    const config = options.config;
    const base = String(config.apiBase || '').replace(/\/+$/, '');

    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

    const requestBody = {
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
    };

    if (isDeepSeekEndpoint(base)) {
      requestBody.thinking = { type: config.thinking ? 'enabled' : 'disabled' };
    }

    const body = JSON.stringify(requestBody);

    let seen = 0;
    let accumulated = '';
    let usage = null;
    let finishReason = '';
    let reasoningSeen = false;
    let aborted = false;
    let settled = false;
    let waitingNotified = false;

    const parser = createSseParser((payload) => {
      const tokens = extractUsage(payload);
      if (tokens !== null) usage = tokens;

      const choice = payload && payload.choices && payload.choices[0];
      if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = extractDelta(payload);
      if (delta) {
        accumulated += delta;
        if (options.onDelta) options.onDelta(delta);
        return;
      }

      const piece = choice && choice.delta;
      if (piece && typeof piece.reasoning_content === 'string' && piece.reasoning_content) {
        reasoningSeen = true;
      }

      if (waitingNotified) return;
      if (piece && (typeof piece.reasoning_content === 'string' || piece.role)) {
        waitingNotified = true;
        if (options.onWaiting) options.onWaiting();
      }
    });

    function feed(text) {
      if (text.length <= seen) return;
      const fresh = text.slice(seen);
      seen = text.length;
      parser.push(fresh);
    }

    function fail(message) {
      if (aborted || settled) return;
      settled = true;
      if (options.onError) options.onError(message);
    }

    const handle = GM_xmlhttpRequest({
      method: 'POST',
      url: base + '/chat/completions',
      headers,
      data: body,
      timeout: Math.round(config.timeoutSec * 1000),

      onprogress(response) {
        if (aborted || settled) return;
        feed(response && response.responseText ? response.responseText : '');
      },

      onload(response) {
        if (aborted || settled) return;
        const status = response && typeof response.status === 'number' ? response.status : 0;
        const text = (response && response.responseText) || '';

        if (status >= 400) {
          fail(parseApiError(status, text));
          return;
        }

        feed(text);
        parser.flush();

        if (!accumulated) {
          try {
            const parsed = JSON.parse(text);
            const choice = parsed && parsed.choices && parsed.choices[0];
            accumulated = contentToString(choice && choice.message && choice.message.content);
            if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
            if (choice && choice.message && typeof choice.message.reasoning_content === 'string') {
              reasoningSeen = true;
            }
            const tokens = extractUsage(parsed);
            if (tokens !== null) usage = tokens;
          } catch (error) {
            accumulated = accumulated || '';
          }
        }

        if (!accumulated) {
          fail(describeEmptyAnswer(finishReason, reasoningSeen));
          return;
        }

        settled = true;
        if (options.onDone) options.onDone(accumulated, usage);
      },

      onerror() {
        fail(parseApiError(0, 'Ошибка сети'));
      },

      ontimeout() {
        fail(parseApiError(0, 'Таймаут'));
      },
    });

    return {
      abort() {
        aborted = true;
        settled = true;
        try {
          handle.abort();
        } catch (error) {
          return;
        }
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  const PANEL_ID = 'ai-pyramid-host';

  const STATE_LABELS = {
    idle: '',
    extracting: 'извлечение…',
    requesting: 'запрос…',
    thinking: 'модель думает…',
    streaming: 'генерация…',
    done: 'готово',
    error: 'ошибка',
    cached: 'из кэша',
  };

  const BUSY_STATES = new Set(['extracting', 'requesting', 'thinking', 'streaming']);

  const PANEL_CSS = `
    :host { all: initial; }
    .panel {
      --bg: #ffffff;
      --fg: #16181d;
      --muted: #6b7280;
      --line: #e5e7eb;
      --accent: #2563eb;
      --card: #f7f8fa;
      --code: #f1f3f6;
      position: fixed;
      top: 0;
      right: 0;
      height: 100vh;
      width: var(--pyr-width, min(420px, 100vw));
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      box-shadow: -10px 0 30px rgba(0, 0, 0, 0.18);
      border-left: 1px solid var(--line);
      transform: translateX(100%);
      transition: transform 0.22s ease;
    }
    .panel[data-open] { transform: translateX(0); }
    .panel[data-wide] { width: min(96vw, 100vw); }
    .pyr-resize {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      background: transparent;
      touch-action: none;
      z-index: 3;
    }
    .pyr-resize:hover, .pyr-resize:focus-visible { background: var(--accent); opacity: 0.35; }
    #pyr-footer-text { flex: 1 1 auto; min-width: 0; }
    .pyr-export { display: flex; gap: 4px; flex: 0 0 auto; }
    .pyr-export button {
      font: inherit;
      font-size: 11px;
      color: var(--muted);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 2px 6px;
      cursor: pointer;
    }
    .pyr-export button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .pyr-export button:disabled { opacity: 0.4; cursor: default; }
    @media (prefers-color-scheme: dark) {
      .panel {
        --bg: #16181d;
        --fg: #e7e9ee;
        --muted: #9aa3b2;
        --line: #2b2f38;
        --accent: #7aa2ff;
        --card: #1e2229;
        --code: #11141a;
      }
    }
    .pyr-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--card);
    }
    .pyr-title { font-weight: 600; font-size: 14px; margin-right: auto; }
    .pyr-badge {
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 45%;
    }
    .pyr-header button, .pyr-focus-bar button, .pyr-error button {
      font: inherit;
      color: var(--fg);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
    }
    .pyr-header button:hover, .pyr-focus-bar button:hover, .pyr-error button:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .pyr-focus-bar {
      display: flex;
      gap: 8px;
      padding: 10px 14px;
      position: sticky;
      top: 0;
      background: var(--bg);
      border-bottom: 1px solid var(--line);
      z-index: 2;
    }
    .pyr-focus-bar input {
      flex: 1 1 auto;
      min-width: 0;
      font: inherit;
      color: var(--fg);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 8px;
    }
    .pyr-focus-bar input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    .pyr-focus-bar button { white-space: nowrap; }
    .pyr-focus-bar .pyr-icon-btn {
      flex: 0 0 auto;
      width: 32px;
      padding: 4px 0;
      font-size: 16px;
      line-height: 1.2;
      text-align: center;
    }
    .pyr-focus-bar button:disabled, .pyr-focus-bar input:disabled { opacity: 0.55; cursor: default; }
    .pyr-note {
      padding: 0 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .pyr-note:not(:empty) { padding: 8px 14px; border-bottom: 1px solid var(--line); }
    .pyr-content {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 14px;
    }
    .pyr-content h3 { font-size: 15px; margin: 18px 0 8px; }
    .pyr-content h3:first-child { margin-top: 0; }
    .pyr-content p { margin: 0 0 10px; }
    .pyr-content ul, .pyr-content ol { margin: 0 0 10px; padding-left: 22px; }
    .pyr-content li { margin: 2px 0; }
    .pyr-content code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12.5px;
      background: var(--code);
      padding: 1px 4px;
      border-radius: 4px;
    }
    .pyr-content pre {
      background: var(--code);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      overflow-x: auto;
    }
    .pyr-content pre code { background: none; padding: 0; }
    .pyr-content details {
      border-left: 2px solid var(--line);
      padding: 2px 0 2px 10px;
      margin: 8px 0;
    }
    .pyr-content details details { margin-left: 14px; border-left-style: dashed; }
    .pyr-content summary[data-src], .pyr-content li[data-src] { cursor: pointer; }
    .pyr-content summary[data-src]:hover, .pyr-content li[data-src]:hover {
      text-decoration: underline dotted;
      text-underline-offset: 3px;
    }
    .pyr-content summary {
      cursor: pointer;
      font-weight: 600;
      padding: 2px 0;
      list-style: none;
    }
    .pyr-content summary::-webkit-details-marker { display: none; }
    .pyr-content summary::before { content: "▸"; color: var(--accent); margin-right: 6px; }
    .pyr-content details[open] > summary::before { content: "▾"; }
    .pyr-content summary:focus-visible { outline: 2px solid var(--accent); }
    .pyr-error { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
    .pyr-error p { margin: 0; }
    .pyr-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11.5px;
    }
    .pyr-sent {
      border-top: 1px solid var(--line);
      padding: 6px 14px 10px;
      color: var(--muted);
      font-size: 11.5px;
    }
    .pyr-sent summary { cursor: pointer; }
    .pyr-sent pre {
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 11.5px;
      margin: 8px 0 0;
    }
    .pyr-sent[hidden] { display: none; }
    #pyr-settings {
      position: absolute;
      inset: 0;
      background: var(--bg);
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 5;
    }
    #pyr-settings h2 { font-size: 15px; margin: 0 0 4px; }
    #pyr-settings label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
    #pyr-settings input[type="text"], #pyr-settings input[type="password"], #pyr-settings input[type="number"] {
      font: inherit;
      color: var(--fg);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 8px;
    }
    #pyr-settings .pyr-row { display: flex; gap: 10px; }
    #pyr-settings .pyr-row label { flex: 1 1 0; }
    #pyr-settings .pyr-key-row { display: flex; gap: 6px; }
    #pyr-settings .pyr-key-row input { flex: 1 1 auto; min-width: 0; }
    #pyr-settings button {
      font: inherit;
      color: var(--fg);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
    }
    #pyr-settings button:hover { border-color: var(--accent); color: var(--accent); }
    #pyr-settings .pyr-check { flex-direction: row; align-items: center; gap: 8px; color: var(--fg); }
    #pyr-settings .pyr-presets { display: flex; flex-wrap: wrap; gap: 6px; }
    #pyr-settings .pyr-hint { color: var(--muted); font-size: 11.5px; margin: 0; }
    #pyr-settings .pyr-actions { display: flex; gap: 8px; margin-top: 4px; }
    #pyr-settings .pyr-hotkeys {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
    }
    #pyr-settings .pyr-hotkeys legend { padding: 0 4px; color: var(--muted); font-size: 12px; }
    #pyr-settings .pyr-hotkeys label {
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: var(--fg);
    }
    #pyr-settings .pyr-hotkeys button[data-hotkey] {
      min-width: 96px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    #pyr-settings .pyr-hotkeys button[data-hotkey][data-capturing] {
      border-color: var(--accent);
      color: var(--accent);
    }
    #pyr-settings .pyr-hotkeys button[data-action="resetHotkeys"] { align-self: flex-start; }
  `;

  const PANEL_HTML = `
    <div class="panel" role="dialog" aria-label="Пирамида знаний" data-state="idle">
      <div class="pyr-resize" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Изменить ширину панели"></div>
      <header class="pyr-header">
        <span class="pyr-title">Пирамида знаний</span>
        <span class="pyr-badge" id="pyr-state"></span>
        <button type="button" data-action="wide" title="Развернуть" aria-label="Развернуть на весь экран" aria-pressed="false">⤢</button>
        <button type="button" data-action="settings" title="Настройки" aria-label="Настройки">⚙</button>
        <button type="button" data-action="close" title="Закрыть" aria-label="Закрыть">×</button>
      </header>
      <div class="pyr-focus-bar">
        <input id="pyr-focus" type="text" placeholder="фокус, например: только архитектура" aria-label="Фокус" />
        <button type="button" data-action="rebuild" class="pyr-icon-btn" title="Перестроить пирамиду" aria-label="Перестроить пирамиду">↻</button>
        <button type="button" data-action="cancel" hidden>Отменить</button>
      </div>
      <div class="pyr-note" id="pyr-note"></div>
      <div class="pyr-content" id="pyr-content"></div>
      <details class="pyr-sent" id="pyr-sent" hidden>
        <summary>показать отправленный текст</summary>
        <pre></pre>
      </details>
      <footer class="pyr-footer" id="pyr-footer">
        <span id="pyr-footer-text"></span>
        <span class="pyr-export">
          <button type="button" data-export="md" title="Скачать Markdown" disabled>↓ MD</button>
          <button type="button" data-export="org" title="Скачать Org" disabled>↓ Org</button>
        </span>
      </footer>
    </div>
  `;

  let panelRefs = null;
  let rebuildHandler = null;
  let cancelHandler = null;
  let settingsHandler = null;
  let lastRenderedHtml = '';
  let capturingHotkey = null;
  let hotkeyCaptureHandler = null;
  let panelWidth = null;
  let panelWide = false;

  const UI_KEY = 'pyr.ui';
  const MIN_PANEL_WIDTH = 340;

  function maxPanelWidth() {
    return Math.round((window.innerWidth || 1024) * 0.98);
  }

  function readPanelUi() {
    const stored = storageGet(UI_KEY, null);
    if (!stored || typeof stored !== 'object') return;
    if (typeof stored.width === 'number' && Number.isFinite(stored.width)) {
      panelWidth = stored.width;
    }
    panelWide = stored.wide === true;
  }

  function savePanelUi() {
    storageSet(UI_KEY, { width: panelWidth, wide: panelWide });
  }

  function applyPanelUi() {
    if (!panelRefs) return;
    if (panelWidth != null) {
      panelRefs.panel.style.setProperty('--pyr-width', panelWidth + 'px');
    } else {
      panelRefs.panel.style.removeProperty('--pyr-width');
    }
    if (panelWide) {
      panelRefs.panel.setAttribute('data-wide', '');
    } else {
      panelRefs.panel.removeAttribute('data-wide');
    }
    if (panelRefs.wide) {
      panelRefs.wide.setAttribute('aria-pressed', panelWide ? 'true' : 'false');
      panelRefs.wide.title = panelWide ? 'Свернуть' : 'Развернуть';
    }
  }

  function setPanelWidth(px) {
    const clamped = Math.min(maxPanelWidth(), Math.max(MIN_PANEL_WIDTH, Math.round(Number(px) || 0)));
    panelWidth = clamped;
    if (panelRefs) panelRefs.panel.style.setProperty('--pyr-width', clamped + 'px');
    return clamped;
  }

  function togglePanelWide() {
    panelWide = !panelWide;
    applyPanelUi();
    savePanelUi();
    return panelWide;
  }

  function ensureHost() {
    if (panelRefs) return panelRefs;

    const host = document.createElement('div');
    host.id = PANEL_ID;
    host.setAttribute('hidden', '');
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.right = '0';
    host.style.zIndex = '2147483646';
    host.style.pointerEvents = 'none';

    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;

    document.body.appendChild(host);

    const pick = (selector) => root.querySelector(selector);

    panelRefs = {
      host,
      root,
      panel: pick('.panel'),
      badge: pick('#pyr-state'),
      content: pick('#pyr-content'),
      note: pick('#pyr-note'),
      footer: pick('#pyr-footer'),
      footerText: pick('#pyr-footer-text'),
      wide: pick('button[data-action="wide"]'),
      resize: pick('.pyr-resize'),
      exportMd: pick('[data-export="md"]'),
      exportOrg: pick('[data-export="org"]'),
      input: pick('#pyr-focus'),
      rebuild: pick('button[data-action="rebuild"]'),
      cancel: pick('button[data-action="cancel"]'),
      close: pick('button[data-action="close"]'),
      settings: pick('.pyr-header button[data-action="settings"]'),
      sent: pick('#pyr-sent'),
      sentPre: pick('#pyr-sent pre'),
    };

    readPanelUi();
    applyPanelUi();

    let dragStartX = 0;
    let dragStartWidth = 0;

    panelRefs.wide.addEventListener('click', () => togglePanelWide());

    panelRefs.resize.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const current = panelRefs.panel.getBoundingClientRect().width || panelWidth || 420;
      setPanelWidth(current + (event.key === 'ArrowLeft' ? 40 : -40));
      savePanelUi();
    });

    panelRefs.resize.addEventListener('pointerdown', (event) => {
      dragStartX = event.clientX;
      dragStartWidth = panelRefs.panel.getBoundingClientRect().width || 420;
      if (panelRefs.resize.setPointerCapture) {
        panelRefs.resize.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    });

    panelRefs.resize.addEventListener('pointermove', (event) => {
      if (dragStartX === 0) return;
      setPanelWidth(dragStartWidth + (dragStartX - event.clientX));
    });

    const endDrag = () => {
      if (dragStartX === 0) return;
      dragStartX = 0;
      savePanelUi();
    };
    panelRefs.resize.addEventListener('pointerup', endDrag);
    panelRefs.resize.addEventListener('pointercancel', endDrag);

    panelRefs.content.addEventListener('click', handleSourceClick);

    panelRefs.exportMd.addEventListener('click', () => downloadPyramid('md'));
    panelRefs.exportOrg.addEventListener('click', () => downloadPyramid('org'));

    panelRefs.close.addEventListener('click', () => closePanel());
    panelRefs.settings.addEventListener('click', () => {
      if (settingsHandler) settingsHandler();
    });
    panelRefs.rebuild.addEventListener('click', () => {
      if (rebuildHandler) rebuildHandler();
    });
    panelRefs.cancel.addEventListener('click', () => {
      if (cancelHandler) cancelHandler();
    });
    panelRefs.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (rebuildHandler) rebuildHandler();
    });

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && !capturingHotkey && isPanelOpen()) closePanel();
      },
      true,
    );

    return panelRefs;
  }

  function isPanelOpen() {
    const host = document.getElementById(PANEL_ID);
    return Boolean(host) && !host.hasAttribute('hidden');
  }

  function openPanel() {
    const refs = ensureHost();
    refs.host.removeAttribute('hidden');
    refs.panel.setAttribute('data-open', '');
    refs.input.focus();
  }

  function closePanel() {
    const refs = ensureHost();
    refs.host.setAttribute('hidden', '');
    refs.panel.removeAttribute('data-open');
    closeSettings();
    stopActiveRequest();
  }

  function setPanelState(state, detail) {
    const refs = ensureHost();
    const options = detail || {};
    let label = STATE_LABELS[state] || '';

    if ((state === 'requesting' || state === 'thinking') && options.seconds != null) {
      label += ' ' + options.seconds + ' с';
    }

    refs.badge.textContent = label;
    refs.panel.setAttribute('data-state', state);

    const busy = BUSY_STATES.has(state);
    refs.cancel.hidden = !busy;
    refs.input.disabled = busy;
    refs.rebuild.disabled = busy;
  }

  function captureViewState(container) {
    const open = [];
    const all = container.querySelectorAll('details');
    for (let index = 0; index < all.length; index += 1) {
      if (all[index].open) open.push(index);
    }
    return { scrollTop: container.scrollTop || 0, open };
  }

  function applyViewState(container, state) {
    if (!state) return;
    const all = container.querySelectorAll('details');
    state.open.forEach((index) => {
      if (all[index]) all[index].open = true;
    });
    container.scrollTop = state.scrollTop;
  }

  function setPanelHtml(html) {
    const refs = ensureHost();
    const state = captureViewState(refs.content);
    refs.content.innerHTML = html;
    applyViewState(refs.content, state);
    lastRenderedHtml = refs.content.innerHTML;
    const ready = lastRenderedHtml.trim().length > 0;
    if (refs.exportMd) refs.exportMd.disabled = !ready;
    if (refs.exportOrg) refs.exportOrg.disabled = !ready;
  }

  function getFocusValue() {
    const refs = ensureHost();
    return refs.input.value;
  }

  function setFocusValue(value) {
    const refs = ensureHost();
    refs.input.value = String(value == null ? '' : value);
  }

  function onRebuild(handler) {
    rebuildHandler = handler;
  }

  function onCancel(handler) {
    cancelHandler = handler;
  }

  function onSettings(handler) {
    settingsHandler = handler;
  }

  function setPanelNote(text) {
    const refs = ensureHost();
    noteBase = text || '';
    if (noteTimer != null) {
      clearTimeout(noteTimer);
      noteTimer = null;
    }
    refs.note.textContent = noteBase;
  }

  function setSentTextPreview(text) {
    const refs = ensureHost();
    const value = String(text == null ? '' : text);
    refs.sentPre.textContent = value;
    refs.sent.hidden = !value;
  }

  function showError(message, opts) {
    const refs = ensureHost();
    refs.content.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'pyr-error';

    const text = document.createElement('p');
    text.textContent = message;
    wrap.appendChild(text);

    if (opts && opts.settings) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = 'settings';
      button.textContent = 'Настройки';
      button.addEventListener('click', () => {
        if (settingsHandler) settingsHandler();
      });
      wrap.appendChild(button);
    }

    refs.content.appendChild(wrap);
  }

  function setFooter(info) {
    const refs = ensureHost();
    const parts = [];

    if (typeof info.sent === 'number' && typeof info.total === 'number') {
      parts.push('отправлено ' + info.sent + ' из ' + info.total + ' символов');
    }
    if (info.responseChars) parts.push('ответ: ' + info.responseChars + ' символов');
    if (info.tokens) parts.push('токенов: ' + info.tokens);
    if (info.model) parts.push(info.model);

    refs.footerText.textContent = parts.join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------

  let activeRequest = null;
  let activeTimer = null;
  let pendingRender = null;
  let runSeq = 0;

  function stopActiveRequest() {
    if (activeRequest) {
      try {
        activeRequest.abort();
      } catch (error) {
        activeRequest = null;
      }
      activeRequest = null;
    }
    if (activeTimer != null) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
    if (pendingRender != null) {
      clearTimeout(pendingRender);
      pendingRender = null;
    }
  }

  function currentExtraction() {
    const config = loadConfig();
    return extractArticle(document, {
      autoExtract: config.autoExtract,
      maxChars: config.maxChars,
    });
  }

  function extractCurrentText() {
    return currentExtraction().text;
  }

  function runPyramid(opts) {
    const options = opts || {};
    stopActiveRequest();
    const token = ++runSeq;

    openPanel();
    setPanelState('extracting');
    setPanelNote('');
    setPanelHtml('');

    const config = loadConfig();
    const extracted = currentExtraction();
    if (token !== runSeq) return;

    setFooter({
      sent: extracted.text.length,
      total: extracted.originalLength,
      responseChars: 0,
      model: config.model,
      tokens: null,
    });
    setSentTextPreview(extracted.text);

    setPanelNote(buildNote(extracted, config.autoExtract));

    const focus = String(options.focus != null ? options.focus : getFocusValue()).trim();

    if (!options.force) {
      const cached = getCached(location.href, extracted.text, focus, config.language);
      if (cached) {
        setPanelHtml(prepareHtml(cached.html));
        setPanelState('cached');
        return;
      }
    }

    let phase = 'requesting';
    let seconds = 0;
    let accumulated = '';

    setPanelState('requesting', { seconds: 0 });

    activeTimer = setInterval(() => {
      seconds += 1;
      setPanelState(phase, { seconds });
    }, 1000);

    function renderNow() {
      if (pendingRender != null) {
        clearTimeout(pendingRender);
        pendingRender = null;
      }
      setPanelHtml(prepareHtml(accumulated));
    }

    activeRequest = requestCompletion({
      config,
      system: buildSystemPrompt(focus, config.language),
      user: buildUserMessage(extracted.text),

      onWaiting() {
        if (token !== runSeq) return;
        phase = 'thinking';
        setPanelState('thinking', { seconds });
      },

      onDelta(chunk) {
        if (token !== runSeq) return;
        accumulated += chunk;
        if (phase !== 'streaming') {
          phase = 'streaming';
          setPanelState('streaming');
        }
        if (pendingRender != null) return;
        pendingRender = setTimeout(() => {
          pendingRender = null;
          if (token !== runSeq) return;
          setPanelHtml(prepareHtml(accumulated));
        }, 200);
      },

      onDone(html, usage) {
        if (token !== runSeq) return;
        stopActiveRequest();
        accumulated = html;
        renderNow();
        putCached(location.href, extracted.text, focus, html, config.language);
        setFooter({
          sent: extracted.text.length,
          total: extracted.originalLength,
          responseChars: html.length,
          model: config.model,
          tokens: usage,
        });
        setPanelState('done');
      },

      onError(message) {
        if (token !== runSeq) return;
        stopActiveRequest();
        showError(message, { settings: true });
        setPanelState('error');
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Settings and triggers
  // ---------------------------------------------------------------------------

  const PRESETS = [
    { id: 'deepseek', apiBase: 'https://api.deepseek.com', model: 'deepseek-flash' },
    { id: 'openai', apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'openrouter', apiBase: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
    { id: 'ollama', apiBase: 'http://localhost:11434/v1', model: 'llama3.1' },
  ];

  let settingsDialog = null;
  let initialized = false;

  function fillSettings(dialog, config) {
    const keyInput = dialog.querySelector('[name="apiKey"]');
    keyInput.value = '';
    keyInput.placeholder = config.apiKey
      ? 'ключ сохранён — введите новый, чтобы заменить'
      : 'ключ не задан';
    dialog.querySelector('[name="apiBase"]').value = config.apiBase;
    dialog.querySelector('[name="model"]').value = config.model;
    dialog.querySelector('[name="maxChars"]').value = String(config.maxChars);
    dialog.querySelector('[name="maxTokens"]').value = String(config.maxTokens);
    dialog.querySelector('[name="temperature"]').value = String(config.temperature);
    dialog.querySelector('[name="timeoutSec"]').value = String(config.timeoutSec);
    dialog.querySelector('[name="autoExtract"]').checked = Boolean(config.autoExtract);
    dialog.querySelector('[name="thinking"]').checked = Boolean(config.thinking);
    dialog.querySelector('[name="language"]').value = config.language;
    HOTKEY_FIELDS.forEach((field) => {
      const button = dialog.querySelector('[data-hotkey="' + field + '"]');
      if (button) button.textContent = config.hotkeys[field];
    });
    updateHotkeyWarning(dialog, config.hotkeys);
  }

  function readSettings(dialog) {
    return {
      apiBase: dialog.querySelector('[name="apiBase"]').value,
      model: dialog.querySelector('[name="model"]').value,
      maxChars: dialog.querySelector('[name="maxChars"]').value,
      maxTokens: dialog.querySelector('[name="maxTokens"]').value,
      temperature: dialog.querySelector('[name="temperature"]').value,
      timeoutSec: dialog.querySelector('[name="timeoutSec"]').value,
      autoExtract: dialog.querySelector('[name="autoExtract"]').checked,
      thinking: dialog.querySelector('[name="thinking"]').checked,
      language: dialog.querySelector('[name="language"]').value,
      hotkeys: readHotkeys(dialog),
    };
  }

  function readHotkeys(dialog) {
    const hotkeys = defaultHotkeys();
    HOTKEY_FIELDS.forEach((field) => {
      const button = dialog.querySelector('[data-hotkey="' + field + '"]');
      const value = button ? (button.dataset.value || button.textContent || '').trim() : '';
      hotkeys[field] = isUsableCombo(value) ? canonicalCombo(value) : DEFAULT_CONFIG.hotkeys[field];
    });
    return hotkeys;
  }

  function updateHotkeyWarning(dialog, hotkeys) {
    const warning = dialog.querySelector('#pyr-hotkey-warning');
    if (!warning) return;
    const reserved = HOTKEY_FIELDS.filter((field) => isReservedCombo(hotkeys[field]));
    if (reserved.length === 0) {
      warning.textContent = '';
      return;
    }
    const names = reserved.map((field) => hotkeys[field]).join(', ');
    warning.textContent = 'Занято браузером: ' + names + '. Комбинация сохранена, но может не сработать.';
  }

  function stopHotkeyCapture() {
    if (!capturingHotkey) return;
    const button = capturingHotkey;
    capturingHotkey = null;
    button.removeAttribute('data-capturing');
    button.textContent = button.dataset.value || '';
  }

  function startHotkeyCapture(dialog, button, field) {
    stopHotkeyCapture();
    capturingHotkey = button;
    button.dataset.capturing = '1';
    button.textContent = 'нажмите…';

    if (!hotkeyCaptureHandler) {
      hotkeyCaptureHandler = (event) => {
        if (!capturingHotkey) return;
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape' || event.code === 'Escape') {
          stopHotkeyCapture();
          return;
        }

        const combo = eventToCombo(event);
        if (!combo || !isUsableCombo(combo)) {
          capturingHotkey.textContent = 'нужен модификатор';
          return;
        }

        const canonical = canonicalCombo(combo);
        capturingHotkey.dataset.value = canonical;
        capturingHotkey.textContent = canonical;
        stopHotkeyCapture();

        if (dialog) {
          const hotkeys = readHotkeys(dialog);
          hotkeys[field] = canonical;
          updateHotkeyWarning(dialog, hotkeys);
        }
      };
    }

    panelRefs.root.addEventListener('keydown', hotkeyCaptureHandler, true);
  }

  function openSettings() {
    const refs = ensureHost();
    openPanel();

    if (settingsDialog) {
      fillSettings(settingsDialog, loadConfig());
      return;
    }

    const dialog = document.createElement('div');
    dialog.id = 'pyr-settings';
    dialog.innerHTML = `
      <h2>Настройки</h2>
      <label>Адрес API
        <input name="apiBase" type="text" spellcheck="false" />
      </label>
      <label>Ключ API
        <span class="pyr-key-row">
          <input name="apiKey" type="password" autocomplete="off" spellcheck="false" />
          <button type="button" data-action="reveal">показать</button>
        </span>
      </label>
      <label>Модель
        <input name="model" type="text" spellcheck="false" />
      </label>
      <div class="pyr-row">
        <label>Макс. символов <input name="maxChars" type="number" min="1000" max="400000" /></label>
        <label>Макс. токенов <input name="maxTokens" type="number" min="256" max="32000" /></label>
      </div>
      <div class="pyr-row">
        <label>Температура <input name="temperature" type="number" min="0" max="2" step="0.1" /></label>
        <label>Таймаут, с <input name="timeoutSec" type="number" min="10" max="600" /></label>
      </div>
      <label class="pyr-check"><input name="autoExtract" type="checkbox" /> Использовать Readability</label>
      <label class="pyr-check"><input name="thinking" type="checkbox" /> Режим размышлений (DeepSeek, медленнее)</label>
      <label>Язык пирамиды
        <select name="language">
          <option value="auto">на языке статьи</option>
          <option value="ru">на русском</option>
          <option value="en">на английском</option>
        </select>
      </label>
      <div class="pyr-presets">
        <button type="button" data-preset="deepseek">DeepSeek</button>
        <button type="button" data-preset="openai">OpenAI</button>
        <button type="button" data-preset="openrouter">OpenRouter</button>
        <button type="button" data-preset="ollama">Ollama</button>
      </div>
      <fieldset class="pyr-hotkeys">
        <legend>Горячие клавиши</legend>
        <label>Открыть/скрыть панель
          <button type="button" data-hotkey="toggle"></button>
        </label>
        <label>Развернуть/свернуть
          <button type="button" data-hotkey="wide"></button>
        </label>
        <label>Перейти к полю вопроса
          <button type="button" data-hotkey="focus"></button>
        </label>
        <button type="button" data-action="resetHotkeys">Сбросить к умолчанию</button>
        <p class="pyr-hint" id="pyr-hotkey-warning"></p>
      </fieldset>
      <p class="pyr-hint">Для Ollama запустите сервер с OLLAMA_ORIGINS=* и адресом http://localhost:11434/v1.</p>
      <div class="pyr-actions">
        <button type="button" data-action="save">Сохранить</button>
        <button type="button" data-action="clearKey">Очистить ключ</button>
        <button type="button" data-action="close">Закрыть</button>
      </div>
    `;

    refs.panel.appendChild(dialog);
    settingsDialog = dialog;

    fillSettings(dialog, loadConfig());

    dialog.querySelector('button[data-action="save"]').addEventListener('click', () => {
      const patch = readSettings(dialog);
      const typed = dialog.querySelector('[name="apiKey"]').value.trim();
      if (typed) patch.apiKey = typed;
      saveConfig(patch);
      invalidateHotkeys();
      closeSettings();
    });
    dialog.querySelector('button[data-action="clearKey"]').addEventListener('click', () => {
      saveConfig({ apiKey: '' });
      fillSettings(dialog, loadConfig());
    });
    dialog.querySelector('button[data-action="close"]').addEventListener('click', () => closeSettings());
    dialog.querySelector('button[data-action="reveal"]').addEventListener('click', () => {
      const input = dialog.querySelector('[name="apiKey"]');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    HOTKEY_FIELDS.forEach((field) => {
      const button = dialog.querySelector('[data-hotkey="' + field + '"]');
      if (!button) return;
      button.dataset.value = button.textContent.trim();
      button.addEventListener('click', (event) => {
        event.preventDefault();
        startHotkeyCapture(dialog, button, field);
      });
    });

    dialog.querySelector('button[data-action="resetHotkeys"]').addEventListener('click', () => {
      const defaults = defaultHotkeys();
      HOTKEY_FIELDS.forEach((field) => {
        const button = dialog.querySelector('[data-hotkey="' + field + '"]');
        if (!button) return;
        button.dataset.value = defaults[field];
        button.textContent = defaults[field];
      });
      updateHotkeyWarning(dialog, defaults);
    });

    PRESETS.forEach((preset) => {
      const button = dialog.querySelector('button[data-preset="' + preset.id + '"]');
      if (!button) return;
      button.addEventListener('click', () => {
        dialog.querySelector('[name="apiBase"]').value = preset.apiBase;
        dialog.querySelector('[name="model"]').value = preset.model;
      });
    });
  }

  function closeSettings() {
    if (!settingsDialog) return;
    settingsDialog.remove();
    settingsDialog = null;
  }

  function isInsidePanel(event) {
    if (!panelRefs || !panelRefs.host) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.indexOf(panelRefs.host) !== -1) return true;
    const target = event.target;
    return Boolean(target) && panelRefs.host.contains(target);
  }

  function isTypingTarget(event) {
    const target = event.target;
    if (!target || target.nodeType !== 1) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  let cachedHotkeys = null;

  function currentHotkeys() {
    if (!cachedHotkeys) cachedHotkeys = loadConfig().hotkeys;
    return cachedHotkeys;
  }

  function invalidateHotkeys() {
    cachedHotkeys = null;
  }

  function togglePanelFromHotkey() {
    if (isPanelOpen()) {
      closePanel();
      return;
    }
    openPanel();
    if (!lastRenderedHtml) runPyramid();
  }

  function toggleWideFromHotkey() {
    if (!isPanelOpen()) openPanel();
    togglePanelWide();
  }

  function focusQuestionFromHotkey() {
    if (!isPanelOpen()) openPanel();
    const refs = ensureHost();
    refs.input.focus();
    refs.input.select();
  }

  function handleHotkey(event) {
    if (capturingHotkey) return;
    if (!event.isTrusted && !globalThis.__PYRAMID_TEST_HOOK__) return;

    const combo = eventToCombo(event);
    if (!combo) return;

    const hotkeys = currentHotkeys();
    let action = null;

    if (combo === canonicalCombo(hotkeys.toggle)) {
      action = togglePanelFromHotkey;
    } else if (combo === canonicalCombo(hotkeys.wide)) {
      action = toggleWideFromHotkey;
    } else if (combo === canonicalCombo(hotkeys.focus)) {
      action = focusQuestionFromHotkey;
    }

    if (!action) return;
    if (!isInsidePanel(event) && isTypingTarget(event)) return;

    event.preventDefault();
    event.stopPropagation();
    action();
  }

  function init() {
    if (initialized) return;
    initialized = true;

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Открыть пирамиду', () => runPyramid());
      GM_registerMenuCommand('Настройки', () => openSettings());
      GM_registerMenuCommand('Очистить кэш', () => clearCache());
    }

    onRebuild(() => runPyramid({ force: true }));
    onCancel(() => {
      stopActiveRequest();
      setPanelState('done');
    });
    onSettings(() => openSettings());

    document.addEventListener('keydown', handleHotkey, true);
  }

  if (globalThis.__PYRAMID_TEST_HOOK__) {
    globalThis.__pyramid = {
      CONFIG_KEY,
      DEFAULT_CONFIG,
      NUMERIC_LIMITS,
      DEFAULT_HOTKEYS: defaultHotkeys(),
      HOTKEY_FIELDS,
      eventToCombo,
      canonicalCombo,
      isUsableCombo,
      isReservedCombo,
      defaultHotkeys,
      invalidateHotkeys,
      loadConfig,
      saveConfig,
      storageGet,
      storageSet,
      storageDelete,
      storageKeys,
      CACHE_PREFIX,
      CACHE_TTL_MS,
      CACHE_MAX_ENTRIES,
      CACHE_MAX_BYTES,
      cacheKey,
      getCached,
      putCached,
      pruneCache,
      clearCache,
      ALLOWED_TAGS,
      DROP_TAGS,
      stripMarkdownFence,
      normalizePyramidLabels,
      prepareHtml,
      sanitizeHtml,
      slugify,
      exportFilename,
      findArticleMatch,
      jumpToSource,
      citationOf,
      pyramidToMarkdown,
      pyramidToOrg,
      exportPyramid,
      downloadPyramid,
      BASE_PROMPT,
      PROMPT_RULES,
      FOCUS_TEMPLATE,
      buildSystemPrompt,
      buildUserMessage,
      MIN_ARTICLE_CHARS,
      SHORT_TEXT_CHARS,
      htmlToPlainText,
      extractArticle,
      buildNote,
      createSseParser,
      extractDelta,
      extractUsage,
      parseApiError,
      requestCompletion,
      PANEL_ID,
      ensureHost,
      openPanel,
      closePanel,
      isPanelOpen,
      setPanelState,
      setPanelHtml,
      captureViewState,
      applyViewState,
      setPanelWidth,
      togglePanelWide,
      getFocusValue,
      setFocusValue,
      onRebuild,
      onCancel,
      onSettings,
      setPanelNote,
      setSentTextPreview,
      showError,
      setFooter,
      stopActiveRequest,
      runPyramid,
      __extractText: extractCurrentText,
      __abortRequest: stopActiveRequest,
      PRESETS,
      openSettings,
      closeSettings,
      init,
      get __root() {
        return panelRefs ? panelRefs.root : null;
      },
    };
  } else {
    init();
  }
})();
