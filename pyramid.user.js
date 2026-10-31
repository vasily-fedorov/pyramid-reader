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

    return config;
  }

  function loadConfig() {
    const stored = storageGet(CONFIG_KEY, null);
    if (stored === null) return coerceConfig(null);
    if (typeof stored === 'string') {
      try {
        return coerceConfig(JSON.parse(stored));
      } catch (error) {
        return coerceConfig(null);
      }
    }
    return coerceConfig(stored);
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

  function cacheKey(url, text, focus) {
    const body = url + '|' + String(text).length + '|' + String(text).slice(0, 64) + '|' + (focus || '');
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

  function putCached(url, text, focus, html) {
    const key = cacheKey(url, text, focus);
    lastCacheTs = Math.max(Date.now(), lastCacheTs + 1);
    storageSet(key, {
      ts: lastCacheTs,
      html: String(html).slice(0, CACHE_MAX_BYTES),
      focus: focus || '',
    });
    pruneCache();
  }

  function getCached(url, text, focus) {
    const key = cacheKey(url, text, focus);
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
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    /* sections are added by the following tasks */
  }

  if (globalThis.__PYRAMID_TEST_HOOK__) {
    globalThis.__pyramid = {
      CONFIG_KEY,
      DEFAULT_CONFIG,
      NUMERIC_LIMITS,
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
    };
  } else {
    init();
  }
})();
