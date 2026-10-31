import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pyramidHtml(systemPrompt) {
  return [
    '<h3>📌 Executive Summary</h3>',
    '<p>Статья объясняет, как устроен цикл событий, почему он не блокирует поток и чем микрозадачи отличаются от макрозадач.</p>',
    '<h3>📐 Тезисы</h3>',
    '<details><summary>Цикл событий обрабатывает очередь задач по одной</summary>',
    '<details><summary>Стек вызовов должен опустеть</summary>',
    '<ul><li>Колбэки ждут, пока стек пуст.</li><li>Порядок обработки — FIFO.</li></ul>',
    '</details>',
    '<details><summary>Микрозадачи идут раньше макрозадач</summary>',
    '<ul><li>Promise резолвится раньше setTimeout с нулевой задержкой.</li><li>Очередь микрозадач опустошается полностью за такт.</li></ul>',
    '</details>',
    '</details>',
    '<details><summary>Блокирующий код останавливает всё</summary>',
    '<details><summary>Синхронный цикл не отдаёт управление</summary>',
    '<ul><li>Пока цикл работает, таймеры не срабатывают.</li><li>Долгая задача искажает задержки.</li></ul>',
    '</details>',
    '<details><summary>Тяжёлую работу выносят из главного потока</summary>',
    '<ul><li>Воркеры и разбиение на части.</li><li>Очередь задач для тяжёлых вычислений.</li></ul>',
    '</details>',
    '</details>',
    '<details><summary>Порядок исполнения предсказуем и проверяем</summary>',
    '<details><summary>Правила порядка фиксированы спецификацией</summary>',
    '<ul><li>Сначала синхронный код.</li><li>Затем микрозадачи.</li><li>Затем макрозадачи.</li></ul>',
    '</details>',
    '<details><summary>Порядок можно наблюдать в отладчике</summary>',
    '<ul><li>Профилировщик показывает таймлайн.</li><li>Логи с метками времени подтверждают теорию.</li></ul>',
    '</details>',
    '</details>',
    '<details><summary>debug: system prompt</summary><pre>' + escapeHtml(systemPrompt) + '</pre></details>',
  ].join('\n');
}

function sseData(payload) {
  return 'data: ' + JSON.stringify(payload) + '\n\n';
}

function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function parseFlags(reqUrl) {
  const url = new URL(reqUrl, 'http://127.0.0.1');
  return url.searchParams;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function failWith(res, flags) {
  const status = Number(flags.get('fail'));
  if (!status) return false;

  const messages = {
    401: 'Incorrect API key provided.',
    429: 'Rate limit reached for requests.',
    500: 'Internal server error.',
  };

  sendJson(res, status, { error: { message: messages[status] || 'Request failed.' } });
  return true;
}

function bodyToString(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (piece) => {
      raw += piece;
    });
    req.on('end', () => resolve(raw));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleCompletion(req, res) {
  const flags = parseFlags(req.url);
  if (failWith(res, flags)) return;

  const raw = await bodyToString(req);
  let system = '';

  try {
    const parsed = JSON.parse(raw);
    const found = (parsed.messages || []).find((message) => message.role === 'system');
    system = found ? String(found.content || '') : '';
  } catch (error) {
    system = '';
  }

  const html = pyramidHtml(system);

  if (flags.get('plain') === '1') {
    sendJson(res, 200, {
      choices: [{ message: { role: 'assistant', content: html } }],
      usage: { completion_tokens: 412, prompt_tokens: 900 },
    });
    return;
  }

  const slow = flags.get('slow') === '1';
  const think = flags.get('think') !== '0';
  const withUsage = flags.get('usage') !== '0';
  const xss = flags.get('xss') === '1';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const emit = async (payload) => {
    res.write(sseData(payload));
    if (slow) await sleep(150);
  };

  if (think) {
    for (let index = 0; index < 5; index += 1) {
      await emit({ choices: [{ delta: { reasoning_content: 'размышление ' + (index + 1) } }] });
    }
  }

  for (const piece of chunkText(html, 120)) {
    await emit({ choices: [{ delta: { content: piece } }] });
  }

  if (xss) {
    await emit({ choices: [{ delta: { content: '<script>alert(1)</script><img src=x onerror=alert(2)>' } }] });
  }

  if (withUsage) {
    res.write(sseData({ usage: { completion_tokens: 412, prompt_tokens: 900 } }));
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

function serveFile(res, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
    res.end(body);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleCompletion(req, res);
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveFile(res, path.join(HERE, 'fixture.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/pyramid.user.js') {
    serveFile(res, path.join(HERE, '..', 'pyramid.user.js'), 'text/javascript; charset=utf-8');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write('Pyramid stand: http://127.0.0.1:' + PORT + '/\n');
});
