import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGas } from './lib/gas-mock.mjs';

const docs = path.resolve(fileURLToPath(new URL('../docs/', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 12000000) throw new Error('本文が大きすぎます。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(value));
}
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve('http://127.0.0.1:' + server.address().port); });
  });
}
function stop(server) {
  return new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}

// メモリ内の偽GAS以外には接続しない。操作口はループバックでのみ公開する。
export async function startMock({ sitePort = 0, gasPort = 0, videoChunkBytes } = {}) {
  const gas = createGas({ urlRoutes: [
    { url: 'https://maps.app.goo.gl/spm-test', response: { status: 302, headers: { Location: 'https://www.google.com/maps?q=37.0412,136.7790' } } }
  ] });
  if (videoChunkBytes !== undefined) {
    if (!Number.isSafeInteger(videoChunkBytes) || videoChunkBytes < 256 * 1024 || videoChunkBytes % (256 * 1024)) throw new Error('試験の動画の塊は256KBの倍数で指定してください。');
    gas.context.VIDEO_CHUNK_BYTES = videoChunkBytes;
  }
  const pausedVideoResponses = new Map();
  const echoes = new Map(), flags = { dropNextUploadResponse: false, pauseAfterVideoChunk: false, failAfterVideoChunk: false };
  const metrics = { options: 0, redirects: 0, droppedUploads: 0, requests: [], videoStarts: [], videoChunks: [], pausedVideoChunks: 0, failedVideoChunks: 0 };
  function reply(res, value) {
    for (const [key, entry] of echoes) if (entry.until < Date.now()) echoes.delete(key);
    const key = randomUUID(); echoes.set(key, { value, until: Date.now() + 60000 }); metrics.redirects++;
    res.writeHead(302, { Location: '/echo?key=' + key, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end();
  }
  function state() {
    return {
      props: gas.props.getProperties(), now: gas.control.now,
      sheets: Object.fromEntries([...gas.sheets].map(([name, sheet]) => [name, { data: sheet.data, hidden: sheet.isSheetHidden() }])),
      drive: {
        folders: [...gas.drive.folders.values()].map(f => ({ id: f.getId(), name: f.getName(), parentId: f.parent, fileIds: f.fileIds })),
        files: [...gas.drive.files.values()].map(f => ({ id: f.getId(), name: f.getName(), folderId: f.folderId, trashed: f.isTrashed(), mime: f.getBlob().getContentType(), b64: Buffer.from(f.getBlob().getBytes().map(n => n & 255)).toString('base64') }))
      }, counters: { ...gas.counters }, metrics, flags: { ...flags }
    };
  }
  const gasServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      metrics.requests.push({ method: req.method, path: url.pathname });
      if (req.method === 'OPTIONS') { metrics.options++; json(res, { ok: false, message: '事前確認には対応しません。' }, 405); return; }
      if (url.pathname === '/test/state' && req.method === 'GET') { json(res, state()); return; }
      if (url.pathname === '/test/run' && req.method === 'POST') {
        const data = await body(req); json(res, gas.call(data.fn, ...(data.args || [])) ?? null); return;
      }
      if (url.pathname === '/test/flags' && req.method === 'POST') {
        const data = await body(req);
        if (typeof data.dropNextUploadResponse === 'boolean') flags.dropNextUploadResponse = data.dropNextUploadResponse;
        if (typeof data.pauseAfterVideoChunk === 'boolean') flags.pauseAfterVideoChunk = data.pauseAfterVideoChunk;
        if (typeof data.failAfterVideoChunk === 'boolean') flags.failAfterVideoChunk = data.failAfterVideoChunk;
        if (data.pauseAfterVideoChunk === false) {
          for (const [response, resume] of pausedVideoResponses) if (!response.destroyed) resume();
          pausedVideoResponses.clear();
        }
        json(res, { ok: true, flags }); return;
      }
      if (url.pathname === '/echo' && req.method === 'GET') {
        const key = url.searchParams.get('key'), entry = echoes.get(key);
        if (!entry || entry.until < Date.now()) { json(res, { ok: false, message: '応答の期限が切れました。' }, 404); return; }
        echoes.delete(key); json(res, entry.value); return;
      }
      if (url.pathname !== '/exec' || !['GET', 'POST'].includes(req.method)) { json(res, { ok: false, message: '受け口がありません。' }, 404); return; }
      const data = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
      const value = req.method === 'POST' ? gas.doPost(data) : gas.doGet(data);
      if (data.a === 'videoStart') metrics.videoStarts.push({ id: data.id, next: value.next, dup: !!value.dup });
      if (data.a === 'videoChunk') metrics.videoChunks.push({ id: data.id, start: data.start, next: value.next, done: !!value.done });
      if (data.a === 'videoChunk' && value.ok && !value.done) {
        // 塊の保存後に一度だけ503を返す。接続を切るとブラウザがPOSTを自動再送してしまう。
        const fail = flags.failAfterVideoChunk; flags.failAfterVideoChunk = false;
        const respond = () => {
          if (fail) { metrics.failedVideoChunks++; json(res, { ok: false, message: '動画の塊は保存しましたが、正常な返事を返せませんでした。' }, 503); }
          else reply(res, value);
        };
        if (flags.pauseAfterVideoChunk) {
          flags.pauseAfterVideoChunk = false; metrics.pausedVideoChunks++;
          // 進捗の撮影と圏外の確認が済んだら、pauseAfterVideoChunk:falseで返事を返す。
          pausedVideoResponses.set(res, respond); res.once('close', () => pausedVideoResponses.delete(res));
        } else respond();
        return;
      }
      if (data.a === 'upload' && value.ok && flags.dropNextUploadResponse) {
        flags.dropNextUploadResponse = false; metrics.droppedUploads++; req.socket.destroy(); return;
      }
      reply(res, value);
    } catch (error) { if (!res.destroyed) json(res, { ok: false, message: '試験用の要求を処理できませんでした。', detail: error.message }, 400); }
  });
  let gasOrigin;
  const siteServer = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith('/')) relative += 'index.html';
      const full = path.resolve(docs, '.' + relative);
      if (!full.startsWith(docs + path.sep) || relative.includes('\\') || relative.includes('\0')) { res.writeHead(403); res.end(); return; }
      let data = await fs.readFile(full);
      if (path.extname(full) === '.html') data = Buffer.from(data.toString('utf8').replace(/connect-src 'self'/g, "connect-src 'self' " + gasOrigin));
      res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('ファイルがありません。'); }
  });
  try {
    gasOrigin = await listen(gasServer, gasPort);
    gas.control.webAppUrl = gasOrigin + '/exec';
    const siteUrl = await listen(siteServer, sitePort);
    let closing;
    return { siteUrl, gasUrl: gasOrigin + '/exec', gas, close() { if (!closing) closing = Promise.all([stop(siteServer), stop(gasServer)]).then(() => { echoes.clear(); }); return closing; } };
  } catch (error) { await Promise.allSettled([stop(siteServer), stop(gasServer)]); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mock = await startMock();
  console.log('サイト：' + mock.siteUrl + '\n偽GAS：' + mock.gasUrl);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await mock.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
