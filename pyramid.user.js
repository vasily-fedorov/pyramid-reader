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
    };
  } else {
    init();
  }
})();
