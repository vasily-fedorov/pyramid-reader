import fs from 'node:fs';
import { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';

const USERSCRIPT = new URL('../../pyramid.user.js', import.meta.url);
const openWindows = [];

afterEach(() => {
  while (openWindows.length > 0) {
    const win = openWindows.pop();
    try {
      win.close();
    } catch (error) {
      /* already closed */
    }
  }
});

/**
 * Mount pyramid.user.js inside jsdom with GM_* shims.
 * @param {{html?: string, url?: string, store?: object,
 *          gmRequest?: ((details: any) => {abort(): void}) | null}} [options]
 */
export function loadUserscript({
  html = '<!doctype html><html><head><title>T</title></head><body></body></html>',
  url = 'https://example.com/article',
  store = {},
  gmRequest = null,
} = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'dangerously' });
  const w = dom.window;
  openWindows.push(w);
  const storeMap = new Map(Object.entries(store));
  const menu = [];
  const requests = [];

  w.GM_getValue = (key, fallback) => (storeMap.has(key) ? storeMap.get(key) : fallback);
  w.GM_setValue = (key, value) => {
    storeMap.set(key, value);
  };
  w.GM_deleteValue = (key) => {
    storeMap.delete(key);
  };
  w.GM_listValues = () => [...storeMap.keys()];
  w.GM_registerMenuCommand = (name, fn) => {
    menu.push({ name, fn });
  };
  w.GM_xmlhttpRequest = (details) => {
    requests.push(details);
    return gmRequest ? gmRequest(details) : { abort() {} };
  };

  w.__PYRAMID_TEST_HOOK__ = true;
  w.eval(fs.readFileSync(USERSCRIPT, 'utf8'));

  return {
    dom,
    window: w,
    document: w.document,
    api: w.__pyramid,
    store: storeMap,
    menu,
    requests,
  };
}
