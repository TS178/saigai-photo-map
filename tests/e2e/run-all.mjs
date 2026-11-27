// 書くだけの画面確認。実行するときだけ、一時プロフィールのheadless Edgeを起動する。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { startMock } from '../mock-server.mjs';
import { insertExif } from '../fixtures/exif-fixture.mjs';
import { launchEdge, until, assertTempChild, removeTemp } from './cdp.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..'), shots = path.join(directory, 'shots');
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 Version/15.6 Mobile/15E148 Safari/604.1';
const attack = '<img src=x onerror=alert(1)>', point = { latitude: 37.0412, longitude: 136.7790, accuracy: 12 };
let mock, browser, post, admin, originalId, jpeg, videoId, serial = 0, passed = 0, failed = 0;
const requests = [], tiles = [], unexpected = [], interceptionErrors = [], dialogs = [], runtimeErrors = [], temporary = [];

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); name.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8); return result;
}
function blankPng() {
  const head = Buffer.alloc(13); head.writeUInt32BE(256); head.writeUInt32BE(256, 4); head[8] = 8; head[9] = 2;
  const pixels = Buffer.alloc(256 * (1 + 256 * 3), 242); for (let y = 0; y < 256; y++) pixels[y * 769] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const tilePng = blankPng();
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const text = (value, scope = 'document') => `Array.from(${scope}.querySelectorAll('button,a')).find(e => e.textContent.trim() === ${JSON.stringify(value)} && !e.closest('[hidden]'))`;
const has = value => `document.body.textContent.includes(${JSON.stringify(value)})`;
const dialog = "document.querySelector('[role=dialog]')";
const activeMap = 'spmTest.maps.filter(m=>m.getContainer().isConnected && m.getContainer()._leaflet_id).slice(-1)[0]';
const activeCluster = 'spmTest.clusters[spmTest.clusters.length - 1]';
async function click(page, label, scope) { await page.click(text(label, scope)); }
async function shot(page, name) { await page.screenshot(path.join(shots, name + '.png')); }
async function check(name, run) {
  try { await run(); passed++; console.log('合格：' + name); }
  catch (error) {
    failed++; console.error('不合格：' + name + '（' + error.message + '）');
    for (const [label, page] of [['投稿', post], ['管理', admin]]) {
      if (!page || page.closed) continue;
      try {
        const opened = await page.evaluate(`Array.from(document.querySelectorAll('[role=dialog]')).map(node => ({
          heading: node.querySelector('h1,h2,h3')?.textContent.trim() || '',
          buttons: Array.from(node.querySelectorAll('button')).map(button => button.textContent.trim())
        }))`);
        console.error('失敗時のダイアログ（' + label + '）：' + JSON.stringify(opened));
      } catch (recoveryError) { console.error('ダイアログの記録失敗（' + label + '）：' + recoveryError.message); }
      try {
        await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      } catch (recoveryError) { console.error('ダイアログの終了失敗（' + label + '）：' + recoveryError.message); }
    }
    if (admin && !admin.closed) {
      try {
        await admin.evaluate(`(() => {
          const bar = document.getElementById('position-tools');
          if (bar && !bar.hidden && window.SPM?.adminMap) { SPM.adminMap.cancelEdit(); SPM.admin.render(); }
        })()`);
      } catch (recoveryError) { console.error('位置編集の中止失敗：' + recoveryError.message); }
      try { await admin.bringToFront(); } catch (recoveryError) { console.error('管理画面の前面化失敗：' + recoveryError.message); }
    }
  }
}
async function json(route, data) {
  const response = await fetch(new URL(route, mock.gasUrl), data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) });
  assert.equal(response.status, 200); return response.json();
}
const state = () => json('/test/state');
const run = (fn, ...args) => json('/test/run', { fn, args });
function rows(snapshot, id = originalId) {
  const [head, ...data] = snapshot.sheets['投稿_' + id].data;
  return data.map(row => Object.fromEntries(head.map((name, i) => [name, row[i] ?? ''])));
}
async function credentials() { const s = await state(); return { code: s.props['投稿の合言葉'], pass: s.props['管理画面のパスワード'] }; }
async function rowCount(count, id = originalId) { return until(async () => (await state()).sheets['投稿_' + id].data.length - 1 === count, { timeout: 45000, label: '保存した写真の枚数' }); }
async function db(page, store) {
  // IndexedDBのgetAllはUUID順。画面と同じ並びで下書きを確かめる。
  return page.evaluate(`SPM.outbox.all(${JSON.stringify(store)}).then(rows => ${store === 'draft' ? 'rows.sort((a,b)=>a.createdAt-b.createdAt||a.order-b.order)' : 'rows'})`);
}
async function home(page) {
  await page.bringToFront();
  await page.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl));
  await page.wait(`${has('いまいる場所で送る')} && !${q('#code')}`);
}
async function addPhotos(page, count, { exif = false, heic = false } = {}) {
  const files = Array.from({ length: count }, (_, index) => {
    const data = heic ? Buffer.from('これはJPEGでないHEICの試験です') : exif && index === 0 ? Buffer.from(insertExif(Buffer.from(jpeg, 'base64'))) : Buffer.from(jpeg, 'base64');
    return { name: '試験-' + (++serial) + (heic ? '.heic' : '.jpg'), type: heic ? 'image/heic' : 'image/jpeg', data: data.toString('base64') };
  });
  const before = (await db(page, 'draft')).length;
  await page.evaluate(`(() => {
    const input = Array.from(document.querySelectorAll('input[type=file]')).find(e => e.multiple);
    const transfer = new DataTransfer();
    for (const item of ${JSON.stringify(files)}) transfer.items.add(new File([Uint8Array.from(atob(item.data), c => c.charCodeAt(0))], item.name, {type:item.type,lastModified:Date.now()}));
    input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  if (!heic) await until(async () => (await db(page, 'draft')).length === before + count, { timeout: 30000, label: '写真の下書き保存' });
}
async function sendPhotos(page) {
  await page.wait(`${q('.send-button')} && !${q('.send-button')}.disabled`);
  await page.click(q('.send-button'));
  await page.wait(has('送信の結果'), { timeout: 60000 });
}
async function singleLine(page, screen) {
  const result = await page.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('#main button,#main a.button,#main .file-picker,#main h2,#main h3'));
    return nodes.filter(n => !n.closest('[hidden]') && n.getBoundingClientRect().width && getComputedStyle(n).visibility !== 'hidden').map(node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), rects = []; let textNode;
      while ((textNode = walker.nextNode())) {
        if (!textNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(textNode);
        for (const r of range.getClientRects()) if (r.width && r.height) rects.push({top:r.top,bottom:r.bottom,left:r.left,right:r.right});
      }
      // 絵文字と日本語で字の高さが違っても、縦方向に重なる矩形は同じ行。
      const lines = [];
      for (const r of rects.sort((a,b)=>a.top-b.top)) {
        const line = lines.find(l=>Math.min(l.bottom,r.bottom)>Math.max(l.top,r.top));
        if (line) { line.top=Math.min(line.top,r.top); line.bottom=Math.max(line.bottom,r.bottom); }
        else lines.push({...r});
      }
      const r=node.getBoundingClientRect();
      return {label:node.textContent.trim(),lines:lines.length,clipped:node.scrollWidth>node.clientWidth+1 || rects.some(t=>t.left<r.left-1 || t.right>r.right+1)};
    });
  })()`);
  assert.ok(result.length, screen + 'のボタンがある');
  for (const item of result) { assert.ok(item.lines <= 1, screen + '：' + item.label + 'が' + item.lines + '行'); assert.equal(item.clipped, false, screen + '：' + item.label + 'が見切れない'); }
}
async function locateCircle(page, scope = 'document') {
  const sizes = await page.evaluate(`Array.from(${scope}.querySelectorAll('.map-locate')).filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {w:r.width,h:r.height,svg:!!n.querySelector('svg'),label:n.getAttribute('aria-label')};})`);
  assert.ok(sizes.length);
  for (const size of sizes) { assert.ok(Math.abs(size.w-size.h)<=1); assert.ok(size.w<=44 && size.h<=44); assert.equal(size.svg,true); assert.equal(size.label,'現在地に移動'); }
}
async function postMapControls(page) {
  await page.evaluate("document.querySelector('.base-row').scrollIntoView({block:'center',behavior:'instant'})");
  await locateCircle(page);
  for (const label of ['航空写真', '予備', '標準']) {
    const target = `Array.from(document.querySelectorAll('.base-row button')).find(n=>n.dataset.label===${JSON.stringify(label)})`;
    const inside = await page.evaluate(`(() => {const n=${target},r=n.getBoundingClientRect(),m=document.querySelector('#main .map').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&r.bottom<=m.top;})()`);
    assert.equal(inside, true, label + 'が地図の上で全部見える');
    await page.click(target); await page.wait(`${target}.getAttribute('aria-pressed')==='true'`);
    const base = { '標準': 'osm', '航空写真': 'photo', '予備': 'gsiStd' }[label];
    assert.equal(await page.evaluate("localStorage.getItem('spm-base')"), base);
    assert.equal(await page.evaluate(`(() => {const map=${activeMap},layers=Object.values(map._layers).filter(l=>l._url).map(l=>l._url);return layers.includes(SPM_CONFIG.tiles[${JSON.stringify(base)}]);})()`), true);
  }
}
async function addVideo(page) {
  // 録画の完了はevaluateの外から待つ。画面の処理を待つPromiseは返さない。
  await page.evaluate(`(() => {
    spmTest.videoFile=null; spmTest.videoError='';
    const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d'),frame=ctx.createImageData(640,360),pixels=new Uint32Array(frame.data.buffer);
    let seed=12345;
    const draw=()=>{for(let i=0;i<pixels.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[i]=(seed&0xffffff)|0xff000000;}ctx.putImageData(frame,0,0);};
    draw(); const stream=canvas.captureStream(30),chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:8000000});
    const timer=setInterval(draw,33);
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onerror=()=>{spmTest.videoError='録画できませんでした';};
    recorder.onstop=()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop());spmTest.videoFile=new File(chunks,'試験の動画.webm',{type:'video/webm',lastModified:Date.now()});};
    recorder.start(100); setTimeout(()=>recorder.stop(),2100);
  })(); true`);
  await page.wait('spmTest.videoFile || spmTest.videoError', { timeout: 15000 });
  assert.equal(await page.evaluate('spmTest.videoError'), '');
  assert.ok(await page.evaluate('spmTest.videoFile.size > 256*1024'), '2つ以上の塊になる動画');
  const before = (await db(page, 'draft')).length;
  await page.evaluate(`(() => {
    const label=Array.from(document.querySelectorAll('.file-picker')).find(n=>n.textContent.includes('🎥 動画'));
    const input=label.querySelector('input'),transfer=new DataTransfer(); transfer.items.add(spmTest.videoFile);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await until(async () => (await db(page, 'draft')).length === before+1, {timeout:30000,label:'動画の下書き'});
}
async function detailMap(page, chosen) {
  await page.wait(`!!${q('.detail-map .leaflet-interactive')}`);
  const info=await page.evaluate(`(() => {
    const map=spmTest.maps.find(m=>m.getContainer()===document.querySelector('.detail-map'));
    spmTest.detailMap=map; spmTest.detailRemoved=false; map.once('unload',()=>{spmTest.detailRemoved=true;});
    const marker=Object.values(map._layers).find(m=>m instanceof L.CircleMarker);
    const point=marker.getLatLng(); return {height:map.getContainer().getBoundingClientRect().height,zoom:map.getZoom(),lat:point.lat,lng:point.lng,color:marker.options.color};
  })()`);
  assert.equal(info.height,220); assert.equal(info.zoom,17); assert.equal(info.lat,chosen.lat); assert.equal(info.lng,chosen.lng);
  assert.equal(info.color,await page.evaluate(`SPM.adminMap.color(${JSON.stringify(chosen.cat)})`));
}
async function closeDialog(page) { if (await page.evaluate(`!!${dialog}`)) await click(page, '閉じる', dialog); }
async function confirmAdmin(page) { await click(page, '実行する', dialog); }
async function groups(page = admin) { return page.evaluate('SPM.admin.filtered().map(p => ({...p, photos:p.photos.map(r => ({...r}))}))'); }
function recordInterceptionError(error) {
  const message = error.message || String(error);
  // 移動や終了で失効した要求への返事は、横取りの失敗に数えない。
  if (/Invalid InterceptionId|No resource with given|Target closed|Session closed|Inspected target navigated|No target with given id|Session with given id not found|CDP接続が閉じました/i.test(message)) return;
  interceptionErrors.push(message);
}
async function setupPage(page) {
  page.cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails.text));
  page.cdp.on('Page.javascriptDialogOpening', event => {
    dialogs.push({ type: event.type, message: event.message });
    // 仕様どおりの確認とページから離れる確認は受け入れ、両方を記録する。最後はalertだけ0件を確認する。
    page.cdp.send('Page.handleJavaScriptDialog', { accept: event.type === 'confirm' || event.type === 'beforeunload' }).catch(recordInterceptionError);
  });
  page.cdp.on('Fetch.requestPaused', event => {
    (async () => {
      const url = new URL(event.request.url);
      if (['tile.openstreetmap.org', 'cyberjapandata.gsi.go.jp'].includes(url.hostname)) {
        await page.cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Cache-Control', value: 'no-store' }], body: tilePng });
        tiles.push(url.href);
      } else if (url.hostname === '127.0.0.1' || ['file:', 'data:', 'blob:', 'about:'].includes(url.protocol)) {
        await page.cdp.send('Fetch.continueRequest', { requestId: event.requestId });
      } else {
        unexpected.push(url.href); await page.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
      }
    })().catch(recordInterceptionError);
  });
  await page.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.spmTest = {maps:[],clusters:[],fetches:[]};
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      // ページからの呼び出しだけを数える。通信層の自動再送は含めず、本文も変えない。
      if (typeof init?.body === 'string') {
        try {
          const body = JSON.parse(init.body);
          if (body && typeof body.a === 'string') spmTest.fetches.push({a:body.a,id:body.id,start:body.start});
        } catch { /* JSONでないfetchは記録しない。 */ }
      }
      return originalFetch.apply(this, arguments);
    };
    document.addEventListener('DOMContentLoaded', () => {
      if (!window.L) return;
      const map = L.map, cluster = L.markerClusterGroup;
      L.map = function(...args) { const value = map.apply(this,args); spmTest.maps.push(value); return value; };
      if (cluster) L.markerClusterGroup = function(options) { const value = cluster.call(this,{...options,animate:false}); spmTest.clusters.push(value); return value; };
    }, {once:true});` });
}
async function network(page, offline) {
  await page.cdp.send('Network.enable');
  await page.cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.wait(`navigator.onLine === ${!offline}`);
  assert.equal(await page.evaluate('navigator.onLine'), !offline, offline ? '圏外になった' : '圏内に戻った');
}
async function mobile(page, ua = iphone) {
  await page.bringToFront();
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.cdp.send('Emulation.setUserAgentOverride', { userAgent: ua });
  await page.cdp.send('Emulation.setGeolocationOverride', point);
  await browser.cdp.send('Browser.grantPermissions', { origin: mock.siteUrl, permissions: ['geolocation'], ...(page.context ? { browserContextId: page.context } : {}) });
}
async function mapTap(page, selector = '.place-map') {
  const coords = await page.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); const r = node.getBoundingClientRect(); return {x:r.x+r.width*.55,y:r.y+r.height*.53}; })()`);
  await tapAt(page, coords);
}
async function tapAt(page, { x, y }) {
  await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function directUpload(overrides = {}) {
  const { code } = await credentials(), hello = await json('/exec', { a: 'hello', code }); assert.equal(hello.ok, true);
  const item = { a: 'upload', token: hello.token, id: randomUUID(), pid: randomUUID(), n: 1, of: 1, lat: point.latitude, lng: point.longitude, acc: 12, src: 'gps', shot: '', cat: 'その他', urgent: false, note: '=1+1', who: '試験担当', org: '本部', ua: 'PC', img: jpeg, thumb: jpeg, ...overrides };
  const reply = await json('/exec', item); assert.equal(reply.ok, true); return item;
}

try {
  await fs.mkdir(shots, { recursive: true });
  mock = await startMock({ videoChunkBytes: 256 * 1024 });
  assert.equal((await run('setup_')).ok, true);
  const started = await run('startDisaster_', '災害', '試験の大雨', 'メニュー'); assert.equal(started.ok, true); originalId = started.id;
  await run('setMapHome_', point.latitude, point.longitude, 16, 'メニュー');
  browser = await launchEdge({ origin: mock.siteUrl, onRequest: item => requests.push(item), onPage: setupPage });
  post = await browser.newPage('about:blank'); await mobile(post);
  const { code } = await credentials();

  await check('投稿1 全角の合言葉で開始', async () => {
    await post.bringToFront();
    await post.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl));
    await post.wait(`!!${q('#code')}`); await shot(post, 'post-code');
    await post.fill(q('#code'), code.replace(/[0-9]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)));
    await post.fill(q('#who'), '試験担当'); await post.fill(q('#org'), '消防団'); await click(post, '始める');
    await post.wait(has('いまいる場所で送る')); await shot(post, 'post-home');
    jpeg = await post.evaluate(`(() => { const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=480; const ctx=canvas.getContext('2d');ctx.fillStyle='#27648a';ctx.fillRect(0,0,640,480);ctx.fillStyle='white';ctx.font='32px sans-serif';ctx.fillText('試験の写真',50,100);return canvas.toDataURL('image/jpeg',.8).split(',')[1]; })()`);
    await readability(post, true); await singleLine(post, 'ホーム');
  });
  await check('投稿2 現地で2枚・GPS・至急・入力を文字で保存', async () => {
    await post.bringToFront();
    const before = rows(await state()).length;
    await click(post, '📷 いまいる場所で送る'); await post.wait(has('精度 ±12m')); await addPhotos(post, 2);
    await post.click(q('[data-cat="冠水・浸水"]')); await post.click(q('.urgent-label input')); await post.fill(q('textarea'), attack);
    await shot(post, 'post-field'); await readability(post, true); await singleLine(post, '現地'); await postMapControls(post); await sendPhotos(post); await rowCount(before + 2); await shot(post, 'post-result');
    const saved = rows(await state()).slice(-2); assert.equal(saved[0]['受付番号'], saved[1]['受付番号']);
    for (const row of saved) { assert.equal(row['位置の取り方'], '現在地(GPS)'); assert.ok(Math.abs(row['緯度'] - point.latitude) < .00001); assert.ok(Math.abs(row['経度'] - point.longitude) < .00001); assert.equal(row['至急'], true); assert.equal(row['コメント'], attack); }
  });
  await check('投稿3 まとめて・EXIF・座標・短いリンク・地図・同じ場所', async () => {
    await post.bringToFront();
    await home(post); await click(post, '🗂 あとで場所を決めて送る'); await addPhotos(post, 3, { exif: true });
    const drafts = await db(post, 'draft'); assert.equal(drafts[0].src, 'exif'); assert.ok(Math.abs(drafts[0].lat - point.latitude) < .00001);
    await shot(post, 'post-batch'); await singleLine(post, 'まとめて');
    await click(post, '場所を決める', "document.querySelectorAll('.photo-card')[1]"); await post.wait(`!!${q('#location-text')}`);
    await post.fill(q('#location-text'), '37.0412, 136.7790'); await click(post, '読み取る');
    await post.wait("Array.from(document.querySelectorAll('#main p[role=status]')).some(e=>e.textContent==='Googleマップ：37.041200, 136.779000')");
    await post.fill(q('#location-text'), 'https://maps.app.goo.gl/spm-test'); await click(post, '読み取る');
    await post.wait(`${text('読み取る')}?.disabled === false`); await until(async () => (await state()).counters.fetches > 0, { label: '短いリンクの偽通信' });
    await post.wait("Array.from(document.querySelectorAll('#main p[role=status]')).some(e=>e.textContent==='Googleマップ：37.041200, 136.779000')");
    await mapTap(post); await singleLine(post, '場所を決める'); await postMapControls(post); await shot(post, 'post-place'); await click(post, 'この場所に決める');
    await post.wait(`document.querySelectorAll('.photo-card').length === 3`);
    await click(post, '前の写真と同じ場所', "document.querySelectorAll('.photo-card')[2]");
    await until(async () => { const d = await db(post, 'draft'); return d[1].src === 'map' && d[2].lat === d[1].lat && d[2].lng === d[1].lng; });
    const before = rows(await state()).length; await sendPhotos(post); await rowCount(before + 3);
    const saved = rows(await state()).slice(-3); assert.equal(saved[0]['位置の取り方'], '写真の位置情報');
    assert.notEqual(saved[0]['受付番号'], saved[1]['受付番号']); assert.equal(saved[1]['受付番号'], saved[2]['受付番号']);
    assert.equal(saved[1]['緯度'], saved[2]['緯度']); assert.equal(saved[1]['経度'], saved[2]['経度']);
  });
  await check('投稿4 圏外の送信待ちと返事を失った写真の二重登録防止', async () => {
    await post.bringToFront();
    await home(post); await click(post, '📷 いまいる場所で送る'); await post.wait(has('精度 ±12m')); await addPhotos(post, 1);
    const before = rows(await state()).length;
    await network(post, true);
    await sendPhotos(post); await post.wait(`${q('#pending-banner')}.textContent.includes('1件') && !${q('#pending-banner')}.hidden`);
    assert.match(await post.evaluate(`${q('#pending-banner')}.className`), /warning/); await click(post, '送信待ちを見る'); await post.wait(`!!${q('.queue-row')}`); await shot(post, 'post-queue'); await singleLine(post, '送信待ち'); assert.equal((await db(post, 'outbox')).length, 1);
    await network(post, false);
    await post.evaluate("window.dispatchEvent(new Event('online'))"); await rowCount(before + 1);
    await until(async () => (await db(post, 'outbox')).length === 0, { timeout: 45000 });
    await home(post); await click(post, '📷 いまいる場所で送る'); await post.wait(has('精度 ±12m')); await addPhotos(post, 1);
    const id = (await db(post, 'draft'))[0].id;
    await json('/test/flags', { dropNextUploadResponse: true }); await sendPhotos(post); await rowCount(before + 2);
    assert.equal(rows(await state()).filter(row => row['写真ID'] === id).length, 1);
    assert.equal((await state()).metrics.droppedUploads, 1); assert.equal((await db(post, 'outbox')).length, 0);
  });
  await check('投稿5 合言葉入りリンクは画面を飛ばしてハッシュを消す', async () => {
    await post.bringToFront();
    const page = await browser.newPage('about:blank', { isolated: true });
    try { await mobile(page); await page.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl) + '#k=' + encodeURIComponent(code)); await page.wait(has('いまいる場所で送る')); assert.equal(await page.evaluate('location.hash'), ''); assert.equal(await page.evaluate(`!!${q('#code')}`), false); }
    finally { await page.close(); }
  });
  await check('投稿6 受付停止の黄色い案内', async () => {
    await post.bringToFront();
    try { await run('stopAccepting_', false, 'メニュー'); await home(post); await post.wait(has('いまは投稿の受付をしていません')); assert.match(await post.evaluate(`${q('#banner')}.className`), /warning/); await shot(post, 'post-closed'); }
    finally { await run('resumeAccepting_', 'メニュー'); await home(post); }
  });
  await check('投稿7 LINEから外部ブラウザへの案内', async () => {
    await post.bringToFront();
    const page = await browser.newPage('about:blank', { isolated: true });
    try { await mobile(page, iphone + ' Line/14.0'); await page.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl) + '#k=' + encodeURIComponent(code)); await page.wait(`!${q('#in-app')}.hidden`); const href = await page.evaluate(`${q('#in-app a')}.href`); assert.equal(new URL(href).searchParams.get('openExternalBrowser'), '1'); assert.equal(new URL(href).hash, '#k=' + code); await shot(page, 'post-line'); }
    finally { await page.close(); }
  });
  await check('投稿8 写真2枚の下書きを読み直して復元', async () => {
    await post.bringToFront();
    await home(post); await click(post, '🗂 あとで場所を決めて送る'); await addPhotos(post, 2);
    const ids = (await db(post, 'draft')).map(row => row.id).sort(); await home(post); await post.wait(has('前の続きがあります'));
    await click(post, '📝 前の続きがあります（2枚）'); await post.wait(`document.querySelectorAll('.photo-card').length === 2`); assert.deepEqual((await db(post, 'draft')).map(row => row.id).sort(), ids);
    for (let i = 0; i < 2; i++) { await click(post, '✕ この写真を外す'); await until(async () => (await db(post, 'draft')).length === 1 - i); }
  });
  await check('投稿9 場所が分からない写真を位置なしで送信', async () => {
    await post.bringToFront();
    await home(post); await click(post, '🗂 あとで場所を決めて送る'); await addPhotos(post, 1); await click(post, '場所が分からない');
    await until(async () => (await db(post, 'draft'))[0].src === 'none'); const before = rows(await state()).length; await sendPhotos(post); await rowCount(before + 1);
    const saved = rows(await state()).at(-1); assert.equal(saved['緯度'], ''); assert.equal(saved['経度'], ''); assert.equal(saved['位置の取り方'], '位置なし');
  });
  await check('投稿10 読めないHEICを下書きに入れない', async () => {
    await post.bringToFront();
    await home(post); await click(post, '🗂 あとで場所を決めて送る'); const before = (await db(post, 'draft')).length; await addPhotos(post, 1, { heic: true });
    await post.wait(has('この写真の形式は送れません')); assert.equal((await db(post, 'draft')).length, before);
  });

  await check('動画 360pxのカード・分割中の圏外・続きから送って1件だけ記録', async () => {
    await post.bringToFront();
    const before = rows(await state()).length;
    try {
      await home(post); await click(post, '🗂 あとで場所を決めて送る'); await addVideo(post);
      const record = (await db(post, 'draft')).find(r=>r.kind==='video'); assert.ok(record); videoId=record.id;
      assert.equal(record.mime, 'video/webm'); assert.ok(await post.evaluate(`SPM.outbox.all('draft').then(rows=>rows.find(r=>r.id===${JSON.stringify(videoId)}).img.byteLength>256*1024)`));
      await click(post, '場所を決める'); await post.wait(`!!${q('.place-map')}`); await mapTap(post); await click(post, 'この場所に決める');
      await post.wait(`!!${q('.photo-card .video-label')}`); await singleLine(post, '動画のカード'); await shot(post, 'post-video-card');
      await json('/test/flags', { pauseAfterVideoChunk: true, failAfterVideoChunk: true });
      await post.click(q('.send-button'));
      await post.wait(`${q('#video-send-progress')}?.textContent.includes('動画 ')`);
      await until(async () => (await state()).metrics.videoChunks.some(r=>r.id===videoId && r.next===256*1024), {timeout:30000,label:'最初の塊の保存'});
      await shot(post, 'post-video-progress');
      await network(post, true); await json('/test/flags', { pauseAfterVideoChunk: false });
      await post.wait(has('送信の結果'), {timeout:30000});
      await post.wait(`${q('#pending-banner')}.textContent.includes('1件')`);
      assert.equal((await db(post, 'outbox')).filter(r=>r.id===videoId).length,1);
      assert.equal(rows(await state()).length,before,'途中の動画は記録しない');
      await click(post, '送信待ちを見る'); await post.wait(`!!${q('.queue-row .video-label')}`); await singleLine(post, '動画の送信待ち');
      await network(post, false); await post.evaluate("window.dispatchEvent(new Event('online'))");
      await rowCount(before+1); await until(async () => !(await db(post,'outbox')).some(r=>r.id===videoId), {timeout:60000,label:'動画の送信完了'});
      const snapshot=await state(), saved=rows(snapshot).filter(r=>r['写真ID']===videoId);
      assert.equal(saved.length,1); assert.equal(saved[0]['種類'],'動画');
      assert.ok(snapshot.metrics.videoStarts.some(r=>r.id===videoId && r.next===256*1024),'サーバーが続きの位置を返す');
      const fetches = await post.evaluate('spmTest.fetches');
      assert.equal(fetches.filter(r=>r.a==='videoChunk' && r.id===videoId && r.start===0).length,1,'ページが最初の塊を送り直さない');
      assert.equal(snapshot.metrics.failedVideoChunks,1,'保存後の503は1回だけ');
      assert.equal(snapshot.metrics.videoChunks.filter(r=>r.id===videoId && r.done).length,1);
      const source=await post.evaluate('spmTest.videoFile.arrayBuffer().then(b=>Array.from(new Uint8Array(b)))');
      const file=snapshot.drive.files.find(f=>f.id===saved[0]['写真ファイルID']);
      assert.ok(file); assert.equal(file.mime,'video/webm'); assert.deepEqual(Buffer.from(file.b64,'base64'),Buffer.from(source),'動画本体を変えずに保存する');
    } finally { await json('/test/flags', {pauseAfterVideoChunk:false,failAfterVideoChunk:false}); await network(post, false); }
  });

  admin = await browser.newPage('about:blank'); await admin.viewport(1366, 900); await admin.bringToFront();
  await check('管理1 誤りと正しいパスワード・付箋・至急・束', async () => {
    await admin.bringToFront();
    await admin.navigate(mock.siteUrl + '/admin.html?api=' + encodeURIComponent(mock.gasUrl) + '&poll=2');
    await admin.fill(q('#admin-pass'), randomUUID()); await click(admin, 'ログイン'); await admin.wait(has('パスワードが違います'));
    const expectedPhotos = rows(await state()).length;
    await admin.fill(q('#admin-pass'), (await credentials()).pass); await click(admin, 'ログイン'); await admin.wait(`${q('#result-count')}.textContent.includes(${JSON.stringify('写真・動画 ')} + ${expectedPhotos} + '件')`);
    const ps = await groups(), located = ps.filter(p => p.lat !== '' && p.lat !== null); assert.equal(await admin.evaluate(`${activeCluster}.getLayers().length`), located.length);
    await admin.evaluate(`void ${activeMap}.setView([37.0412,136.779],19,{animate:false})`);
    await admin.wait("document.querySelector('.is-urgent .urgent-label,.bundle-urgent')?.textContent.includes('至急')"); await shot(admin, 'admin-map');
    await admin.evaluate(`void ${activeMap}.setZoom(9,{animate:false})`); await admin.wait(`!!${q('.bundle-card')}`); await shot(admin, 'admin-cluster'); await readability(admin, false);
  });
  await check('管理2 2秒の差分更新で新着を表示', async () => {
    await admin.bringToFront();
    const before = (await groups()).length; await directUpload(); await admin.wait(`SPM.admin.groups().length === ${before + 1} && !${q('#new-notice')}.hidden`, { timeout: 15000 });
    assert.match(await admin.evaluate(`${q('#new-notice')}.textContent`), /新着/);
  });
  await check('管理 動画の再生・詳細の地図と印・閉じたときの解放', async () => {
    await admin.bringToFront();
    assert.ok(videoId);
    const chosen=(await groups()).find(p=>p.photos.some(r=>r.id===videoId)); assert.ok(chosen);
    await locateCircle(admin, q('#admin-map'));
    await admin.evaluate(`SPM.adminViews.detail(${JSON.stringify(chosen.pid)},${JSON.stringify(videoId)})`);
    await admin.wait(`${q('.detail-video')}?.readyState>=1 && ${q('.detail-video')}.duration>0`, {timeout:60000});
    assert.equal(await admin.evaluate(`${q('.detail-video')}.controls && ${q('.detail-video')}.hasAttribute('playsinline')`),true);
    assert.equal(await admin.evaluate(`${text('Googleドライブで開く',dialog)}?.href.includes('drive.google.com/file/d/')`),true);
    await detailMap(admin,chosen); await shot(admin,'admin-detail-video'); await closeDialog(admin);
    assert.equal(await admin.evaluate('spmTest.detailRemoved'),true);
    assert.equal(await admin.evaluate(`!!${q('.detail-map')}`),false);
    const chosenPhoto=(await groups()).find(p=>p.photos[0].kind!=='video' && typeof p.lat==='number'); assert.ok(chosenPhoto);
    await admin.evaluate(`SPM.adminViews.detail(${JSON.stringify(chosenPhoto.pid)})`);
    await admin.wait(`${q('.detail-photo')}?.naturalWidth>0`); await detailMap(admin,chosenPhoto); await shot(admin,'admin-detail-photo-map'); await closeDialog(admin);
    assert.equal(await admin.evaluate('spmTest.detailRemoved'),true);
    assert.equal(await admin.evaluate(`!!${q('.detail-map')}`),false);
  });
  await check('管理3 タイル・一覧の件数と区分の絞り込み', async () => {
    await admin.bringToFront();
    const ps = await groups(); await click(admin, 'タイル'); assert.equal(await admin.evaluate("document.querySelectorAll('#tiles-view .tile').length"), ps.reduce((n, p) => n + p.photos.length, 0)); await shot(admin, 'admin-tiles');
    await click(admin, '一覧'); assert.equal(await admin.evaluate("document.querySelectorAll('#list-view tbody tr').length"), ps.length); await shot(admin, 'admin-list');
    assert.equal(await admin.evaluate(`Array.from(document.querySelectorAll('#list-view td:nth-child(4) .badge')).every(n=>{const range=document.createRange();range.selectNodeContents(n);return new Set(Array.from(range.getClientRects(),r=>Math.round(r.top))).size<=1;})`),true,'区分の札が1行');
    await click(admin, '絞り込み'); await admin.click("Array.from(document.querySelectorAll('fieldset label')).find(e=>e.textContent==='冠水・浸水').querySelector('input')"); await click(admin, 'この条件で表示する');
    const filtered = await groups(); assert.ok(filtered.length > 0 && filtered.length < ps.length); assert.ok(filtered.every(p => p.cat === '冠水・浸水'));
    await click(admin, '絞り込み'); await click(admin, '条件をすべて解除'); await click(admin, 'この条件で表示する');
  });
  await check('管理4 写真・状況・対応メモ・付箋のドラッグ・非表示', async () => {
    await admin.bringToFront();
    const chosen = (await groups()).find(p => p.note === attack); assert.ok(chosen);
    await click(admin, 'No.' + chosen.no, q('#list-view'));
    await admin.wait(`${q('.detail-photo')}?.naturalWidth > 0`); assert.equal(await admin.evaluate(`${q('.detail-info')}.textContent.includes(${JSON.stringify(attack)})`), true); await shot(admin, 'admin-detail');
    await click(admin, '対応中', dialog); await admin.wait(`${text('対応中', dialog)}?.getAttribute('aria-pressed') === 'true'`);
    await admin.fill(`${dialog}.querySelector('textarea')`, '現地へ移動して確認'); await click(admin, '対応メモを保存', dialog);
    await until(async () => rows(await state()).filter(r => r['まとまりID'] === chosen.pid).every(r => r['状況'] === '対応中' && r['対応メモ'] === '現地へ移動して確認'));
    await click(admin, '位置を直す', dialog); await admin.wait(`!${q('#position-tools')}.hidden`);
    const marker = `Object.values(${activeMap}._layers).find(m => m.dragging?.enabled())`;
    const before = await admin.evaluate(`(() => { const m=${marker}; const ll=m.getLatLng(), r=m.getElement().getBoundingClientRect();return {lat:ll.lat,lng:ll.lng,x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await admin.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
    await admin.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) await admin.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + i * 8, y: before.y + i * 5, button: 'left', buttons: 1 });
    await admin.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x + 48, y: before.y + 30, button: 'left', clickCount: 1 });
    const moved = await admin.evaluate(`({lat:(${marker}).getLatLng().lat,lng:(${marker}).getLatLng().lng})`); assert.notEqual(moved.lat, before.lat);
    await click(admin, 'この位置で保存'); await until(async () => rows(await state()).filter(r => r['まとまりID'] === chosen.pid).every(r => r['位置の取り方'] === '管理者が修正' && Math.abs(r['緯度'] - moved.lat) < .000001));
    await click(admin, '一覧'); await click(admin, 'No.' + chosen.no, q('#list-view')); await click(admin, '非表示にする', dialog); await confirmAdmin(admin);
    await admin.wait(`!SPM.admin.filtered().some(p=>p.pid===${JSON.stringify(chosen.pid)})`);
    await click(admin, '絞り込み'); await admin.click("Array.from(document.querySelectorAll('[role=dialog] label')).find(e=>e.textContent==='非表示を含める').querySelector('input')"); await click(admin, 'この条件で表示する');
    assert.ok((await groups()).some(p => p.pid === chosen.pid)); await click(admin, 'No.' + chosen.no, q('#list-view')); await click(admin, '表示に戻す', dialog); await confirmAdmin(admin);
    await admin.wait(`SPM.admin.groups().find(p=>p.pid===${JSON.stringify(chosen.pid)}).hidden === false`);
    await click(admin, '絞り込み'); await click(admin, '条件をすべて解除'); await click(admin, 'この条件で表示する');
  });
  await check('管理5 受付停止・合言葉の変更・再開・訓練・過去・共有', async () => {
    await admin.bringToFront();
    // localhostでは公開URLを自動保存しないため、共有の対象だけを偽設定へ入れる。
    await admin.evaluate("void SPM.admin.configure({op:'postPageUrl',url:'https://example.invalid/index.html'})");
    await admin.wait("SPM.admin.state.settings.postPageUrl === 'https://example.invalid/index.html'");
    await click(admin, '設定'); const before = (await credentials()).code;
    await click(admin, '受付を止める（合言葉も変える・おすすめ）', dialog); await confirmAdmin(admin);
    await admin.wait(`${dialog}?.textContent.includes('受付：停止中')`); assert.notEqual((await credentials()).code, before);
    await click(admin, '受付を再開する', dialog); await confirmAdmin(admin); await admin.wait(`${dialog}?.textContent.includes('受付：受付中')`);
    await click(admin, '訓練を始める', dialog); await admin.fill(`${dialog}.querySelector('input')`, '試験の訓練'); await click(admin, 'この名前で始める', dialog); await confirmAdmin(admin);
    await admin.wait(`SPM.admin.state.settings.current.kind === '訓練' && document.querySelectorAll('#disaster-select option').length === 2`);
    const trainingId = await admin.evaluate('SPM.admin.state.settings.current.id');
    await admin.wait(`!!${q('.share-panel canvas')} && ${q('.share-panel canvas')}.width > 0`);
    const link = new URL(await admin.evaluate(`${q('.share-panel input[readonly]')}.value`)); assert.equal(link.searchParams.get('openExternalBrowser'), '1'); assert.equal(link.hash, '#k=' + (await credentials()).code);
    await shot(admin, 'admin-settings'); await readability(admin, false); await closeDialog(admin);
    await admin.fill(q('#disaster-select'), originalId); await admin.wait(`SPM.admin.state.d===${JSON.stringify(originalId)} && SPM.admin.groups().length > 0`); assert.match(await admin.evaluate(`${q('#past-banner')}.className`), /warning/); await shot(admin, 'admin-past');
    const oldCount = rows(await state()).length, nextCode = (await credentials()).code;
    await post.bringToFront();
    // 開いたままのページでハッシュだけ変え、helloの取り直しを確かめる。
    const documentTime = await post.evaluate('performance.timeOrigin');
    await post.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl) + '#k=' + encodeURIComponent(nextCode));
    await post.wait(`${has('いまいる場所で送る')} && !${q('#code')} && ${q('#disaster-name')}.textContent === '試験の訓練（訓練）' && location.hash === ''`);
    assert.equal(await post.evaluate('performance.timeOrigin'), documentTime, '読み直さずに新しいリンクでホームと災害名を更新する');
    assert.equal(await post.evaluate("JSON.parse(localStorage.getItem('spm-code'))"), nextCode);
    await click(post, '📷 いまいる場所で送る'); await post.wait(has('精度 ±12m')); await addPhotos(post, 1); await sendPhotos(post); await rowCount(1, trainingId);
    assert.equal(rows(await state()).length, oldCount); assert.equal((await groups()).length, new Set(rows(await state()).map(r => r['まとまりID'])).size);
    await admin.bringToFront();
  });
  await check('管理6 CSV・GeoJSON・KML・写真ZIPの実ファイル', async () => {
    await admin.bringToFront();
    const ps = await groups(), photos = ps.reduce((n, p) => n + p.photos.length, 0), located = ps.filter(p => typeof p.lat === 'number');
    assert.ok(ps.some(p => p.note.startsWith('=')), '数式の防止を検査する投稿がある');
    await click(admin, '出力');
    const csv = await download(admin, 'CSV（Excel用）', '.csv'); verifyCsv(csv, photos);
    const csvText = csv.toString('utf8'); assert.ok(parseCsv(csvText).slice(1).some(row => row[11] === "'=1+1"));
    const geo = JSON.parse((await download(admin, 'GeoJSON（地図ソフト用）', '.geojson')).toString('utf8')); assert.equal(geo.type, 'FeatureCollection'); assert.equal(geo.features.length, located.length);
    assert.ok(geo.features.every(f => f.geometry.type === 'Point' && f.geometry.coordinates.length === 2));
    assert.deepEqual(geo.features.map(f => f.geometry.coordinates), located.map(p => [p.lng, p.lat]));
    const kml = (await download(admin, 'KML（Googleマイマップ・Google Earth用）', '.kml')).toString('utf8'); assert.equal((kml.match(/<Placemark>/g) || []).length, located.length); assert.ok(kml.includes('&lt;img')); assert.ok(!kml.includes(attack));
    const parsed = parseCsv(csvText); assert.deepEqual(parsed[0].slice(-2), ['種類','長さ(秒)']);
    assert.ok(parsed.slice(1).some(r=>r[16]===videoId && r[18]==='動画'));
    assert.ok(geo.features.some(f=>f.properties['種類'].includes('動画'))); assert.ok(geo.features.every(f=>Array.isArray(f.properties['長さ(秒)'])));
    assert.ok(kml.includes('<Data name="種類">') && kml.includes('<Data name="長さ(秒)">'));
    const photoCount=ps.reduce((n,p)=>n+p.photos.filter(r=>r.kind!=='video').length,0);
    assert.equal(await admin.evaluate(`${dialog}.querySelector('input[type=checkbox]').checked`),false,'動画を含める初期値はオフ');
    const zip = readZip(await download(admin, '写真をまとめて保存（ZIP）', '.zip')); assert.equal(zip.size, photoCount + 1); assert.ok(zip.has('一覧.csv')); verifyCsv(zip.get('一覧.csv'), photos);
    for (const [name, bytes] of zip) if (name !== '一覧.csv') { assert.match(name, /^写真\/No\d+-\d+_.+\.jpg$/); assert.equal(bytes.readUInt16BE(0), 0xffd8); }
    await closeDialog(admin);
    await click(admin,'出力'); await admin.click(`${dialog}.querySelector('input[type=checkbox]')`);
    const withVideos=readZip(await download(admin,'写真をまとめて保存（ZIP）','.zip')); assert.equal(withVideos.size,photos+1);
    const entry=Array.from(withVideos).find(([name])=>name.startsWith('動画/')); assert.ok(entry); assert.match(entry[0],/\.webm$/);
    const snapshot=await state(), saved=rows(snapshot).find(r=>r['写真ID']===videoId), file=snapshot.drive.files.find(f=>f.id===saved['写真ファイルID']);
    assert.deepEqual(entry[1],Buffer.from(file.b64,'base64')); await closeDialog(admin);
  });
  await check('管理7 印刷用一覧・GoogleマップQR・PDF', async () => {
    await admin.bringToFront();
    const ps = await groups();
    // OSの印刷ダイアログは出さず、実際の印刷用DOMをPage.printToPDFで受け取る。
    await admin.evaluate('void (window.print=()=>{})'); await click(admin, '印刷'); await admin.wait(`!${q('#print-mode')}.hidden`, { timeout: 60000 });
    assert.equal(await admin.evaluate("document.querySelectorAll('.print-post').length"), ps.length);
    assert.equal(await admin.evaluate("document.querySelectorAll('.print-post canvas').length"), ps.filter(p => typeof p.lat === 'number').length);
    assert.equal(await admin.evaluate("Array.from(document.querySelectorAll('.print-post img')).every(i=>i.complete&&i.naturalWidth>0)"), true);
    assert.ok(await admin.evaluate("Array.from(document.querySelectorAll('.print-video figcaption')).some(n=>n.textContent.startsWith('▶ 動画'))"));
    await shot(admin, 'admin-print');
    const { data } = await admin.cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
    const pdf = Buffer.from(data, 'base64'); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length >= 1);
    await click(admin, '戻る');
  });
  await check('管理8 位置なしの投稿を付箋・束・空いた地図の上に置く', async () => {
    await admin.bringToFront();
    const none = rows(await state()).find(r => r['位置の取り方'] === '位置なし'); assert.ok(none);
    await click(admin, '地図'); await admin.evaluate(`void ${activeMap}.setView([${point.latitude},${point.longitude}],9,{animate:false})`);
    await admin.wait(`${q('#unlocated-button')}.textContent.includes('位置なし 1件')`); await admin.click(q('#unlocated-button')); await click(admin, '地図を押して置く', dialog);
    for (const kind of ['bundle-marker', 'sticky-marker', 'empty']) {
      if (kind === 'bundle-marker') await admin.evaluate(`void ${activeMap}.setView([${point.latitude},${point.longitude}],9,{animate:false})`);
      if (kind === 'sticky-marker') {
        // 動きを止めて展開を始める。画面の応答はevaluateの外から期限つきで待つ。
        const stickyShown = "!!spmTest.placeTarget?.getElement()?.matches('#admin-map .sticky-marker')";
        await admin.evaluate(`void (() => {
          const map = ${activeMap}, group = ${activeCluster}, marker = group.getLayers()[0];
          spmTest.shown = false;
          spmTest.placeTarget = marker;
          group.options.animate = false;
          group.options.animateAddingMarkers = false;
          map.setView(marker.getLatLng(),19,{animate:false});
          if (group.getVisibleParent(marker) === marker) spmTest.shown = true;
          else group.zoomToShowLayer(marker, () => { spmTest.shown = true; });
        })(); true`);
        try { await admin.wait(`spmTest.shown === true || ${stickyShown}`, { timeout: 8000 }); }
        catch { /* 展開の通知が来ない場合も、下で見えている束を直接広げる。 */ }
        if (!await admin.evaluate(stickyShown)) {
          await admin.evaluate(`void (() => {
            const group = ${activeCluster}, parent = group.getVisibleParent(spmTest.placeTarget);
            if (!parent || typeof parent.spiderfy !== 'function') throw new Error('付箋を広げる束がありません。');
            parent.spiderfy();
          })(); true`);
        }
        await admin.wait(stickyShown, { timeout: 8000 });
      }
      if (kind !== 'empty') await admin.wait(`!!${q('#admin-map .' + kind)}`);
      const target = await admin.evaluate(`(() => {
        const map = ${activeMap}, kind = ${JSON.stringify(kind)}, node = map.getContainer();
        node.scrollIntoView({block:'center'});
        // 前に置いた仮のピンが、次に押す対象を隠さないよう表示範囲外へよける。
        for (const layer of Object.values(map._layers)) {
          if (layer.getElement?.()?.classList.contains('place-marker')) layer.setLatLng(map.containerPointToLatLng([-1024,-1024]));
        }
        const label = {'bundle-marker':'束','sticky-marker':'付箋',empty:'空いた地図'}[kind];
        const describeHit = hit => hit ? hit.tagName + ' class="' + hit.getAttribute('class') + '"' : 'null';
        if (kind !== 'empty') {
          const layer = kind === 'sticky-marker' ? spmTest.placeTarget : Object.values(map._layers).find(value => value.getElement?.()?.classList.contains(kind));
          if (!layer) throw new Error('押す付箋または束がありません。');
          const element = layer.getElement(), r = element.getBoundingClientRect(), ll = layer.getLatLng();
          const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
          const hit = document.elementFromPoint(x,y);
          if (!element.contains(hit)) throw new Error(label + 'の上がふさがれています。elementFromPoint: ' + describeHit(hit));
          return {x,y,lat:ll.lat,lng:ll.lng,zoom:map.getZoom()};
        }
        const r = node.getBoundingClientRect(), occupied = Array.from(node.querySelectorAll('.leaflet-marker-icon')).map(element => element.getBoundingClientRect());
        let hit = null;
        for (const fy of [.45,.65,.8,.3]) for (const fx of [.55,.75,.9,.35]) {
          const x = Math.round(r.x + r.width * fx), y = Math.round(r.y + r.height * fy);
          hit = document.elementFromPoint(x,y);
          if (!hit || !node.contains(hit) || !(hit === node || hit.matches('.leaflet-tile,.leaflet-pane,.leaflet-tile-container'))) continue;
          if (occupied.some(box => x >= box.left - 24 && x <= box.right + 24 && y >= box.top - 24 && y <= box.bottom + 24)) continue;
          const ll = map.containerPointToLatLng([x-r.left-node.clientLeft,y-r.top-node.clientTop]);
          return {x,y,lat:ll.lat,lng:ll.lng,zoom:map.getZoom()};
        }
        throw new Error(label + 'の押す場所が見つかりません。elementFromPoint（最後の候補）: ' + describeHit(hit));
      })()`);
      await tapAt(admin, target);
      await admin.wait(`(() => {
        const map = ${activeMap}, marker = Object.values(map._layers).find(value => value.getElement?.()?.classList.contains('place-marker'));
        if (!marker) return false;
        if (${JSON.stringify(kind)} === 'empty') {
          const node = map.getContainer(), r = node.getBoundingClientRect(), p = map.latLngToContainerPoint(marker.getLatLng());
          return Math.abs(p.x - (${target.x} - r.left - node.clientLeft)) <= 2 && Math.abs(p.y - (${target.y} - r.top - node.clientTop)) <= 2;
        }
        const ll = marker.getLatLng(); return Math.abs(ll.lat - (${target.lat})) < .000001 && Math.abs(ll.lng - (${target.lng})) < .000001;
      })()`, { label: kind + 'を押した位置に仮のピンが置かれる' });
      assert.equal(await admin.evaluate(`!!${dialog}`), false, '配置中に詳細を開かない');
      assert.equal(await admin.evaluate(`${activeMap}.getZoom()`), target.zoom, '配置のクリックで拡大しない');
      assert.equal(await admin.evaluate(`${text('この位置に置く')}?.disabled`), false);
    }
    const placed = await admin.evaluate(`(() => {
      const ll = Object.values(${activeMap}._layers).find(value => value.getElement?.()?.classList.contains('place-marker')).getLatLng();
      return {lat:ll.lat,lng:ll.lng};
    })()`);
    await click(admin, 'この位置に置く');
    await until(async () => {
      const saved = rows(await state()).find(r => r['写真ID'] === none['写真ID']);
      return saved['位置の取り方'] === '管理者が修正' && Math.abs(saved['緯度'] - placed.lat) < .000001 && Math.abs(saved['経度'] - placed.lng) < .000001;
    });
  });
  await check('管理9 航空写真は拡大14以上でだけ要求', async () => {
    await admin.bringToFront();
    const before = tiles.length; await admin.evaluate(`void ${activeMap}.setZoom(13,{animate:false})`); await click(admin, '🗺️ 地図の種類');
    assert.equal(await admin.evaluate(`(() => {const r=document.querySelector('#admin-map .base-panel').getBoundingClientRect(),m=document.querySelector('#admin-map').getBoundingClientRect();return r.left>=m.left&&r.right<=m.right&&r.top>=m.top&&r.bottom<=m.bottom;})()`),true,'地図の種類の一覧が見切れない');
    await admin.click(q('[data-label="航空写真"]'));
    await admin.wait(`${q('.photo-notice')}.hidden === false`); assert.equal(tiles.slice(before).filter(url => url.includes('/seamlessphoto/')).length, 0);
    await admin.evaluate(`void ${activeMap}.setZoom(15,{animate:false})`); await until(() => tiles.slice(before).some(url => url.includes('cyberjapandata.gsi.go.jp/xyz/seamlessphoto/15/')), { label: '横取りした航空写真タイル' });
    assert.equal(await admin.evaluate(`${q('.photo-notice')}.hidden`), true);
  });
  await check('管理10 フォルダの写しをfile://で開いてログイン', async () => {
    await admin.bringToFront();
    const folder = await makeTemp('file'), copy = path.join(folder, 'docs');
    await fs.cp(path.join(root, 'docs'), copy, { recursive: true });
    const configFile = path.join(copy, 'config.js'); await fs.writeFile(configFile, (await fs.readFile(configFile, 'utf8')).replace(/gasUrl:\s*'[^']*'/, 'gasUrl: ' + JSON.stringify(mock.gasUrl)), 'utf8');
    const htmlFile = path.join(copy, 'admin.html'); await fs.writeFile(htmlFile, (await fs.readFile(htmlFile, 'utf8')).replace("connect-src 'self'", "connect-src 'self' " + new URL(mock.gasUrl).origin), 'utf8');
    const page = await browser.newPage('about:blank', { isolated: true });
    try {
      await page.bringToFront();
      const snapshot = await state(), currentId = snapshot.props['（変更しない）受付中の災害ID']; assert.ok(currentId);
      const currentRows = rows(snapshot, currentId), expectedPosts = new Set(currentRows.map(row => row['まとまりID'])).size;
      const expectedMarkers = new Set(currentRows.filter(row => !row['非表示'] && Number.isFinite(row['緯度']) && Number.isFinite(row['経度'])).map(row => row['まとまりID'])).size;
      await page.navigate(pathToFileURL(htmlFile).href); await page.fill(q('#admin-pass'), (await credentials()).pass); await click(page, 'ログイン');
      await page.wait('!!window.SPM?.admin?.cache().loaded');
      assert.equal(await page.evaluate('SPM.admin.state.d'), currentId);
      assert.equal(await page.evaluate(`${activeCluster}.getLayers().length`), expectedMarkers); assert.equal(await page.evaluate('SPM.admin.groups().length'), expectedPosts);
    } finally { try { await page.close(); } finally { await admin.bringToFront(); } }
  });
  await check('追加 stateで外部変更を取り直し、見ている災害を保つ', async () => {
    await admin.bringToFront();
    await closeDialog(admin); await run('stopAccepting_', true, 'メニュー'); await admin.click(q('#reload'));
    await admin.wait(`${q('#acceptance')}.textContent.includes('停止中')`); assert.equal(await admin.evaluate('SPM.admin.state.d'), originalId);
    assert.equal(await admin.evaluate('SPM.admin.state.settings.postCode'), (await credentials()).code);
    await run('resumeAccepting_', 'メニュー'); const next = await run('startDisaster_', '訓練', '外で始めた訓練', 'メニュー');
    await admin.click(q('#reload')); await admin.wait(`SPM.admin.state.settings.current.id===${JSON.stringify(next.id)}`);
    assert.equal(await admin.evaluate('SPM.admin.state.d'), originalId); assert.equal(await admin.evaluate("document.querySelectorAll('#disaster-select option').length"), 3); assert.equal(await admin.evaluate(`${q('#current-banner')}.hidden`), false);
    // 過去の災害を見ていても、60秒ごとのstateが動くことを実時間で待つ。
    await click(admin, '設定'); await click(admin, '表示する', dialog); const changed = await run('setPostCode_', null, 'メニュー'); assert.equal(changed.ok, true);
    const nextCode = (await credentials()).code;
    await admin.wait(`SPM.admin.state.settings.postCode===${JSON.stringify(nextCode)}`, { timeout: 70000, interval: 250 });
    const displayed = await admin.evaluate(`${q('.secret-code')}.textContent`); assert.equal(displayed.replace('-', ''), nextCode); assert.equal(await admin.evaluate('SPM.admin.state.d'), originalId); await closeDialog(admin);
  });
  await check('投稿11 前の受付の下書きと送信待ち', async () => {
    await post.bringToFront();
    // 受付中の災害を戻せないため、管理1〜10と追加stateの後で行う。
    const page = await browser.newPage('about:blank', { isolated: true });
    async function openCurrent() {
      const latest = (await credentials()).code;
      // 起動時の復元を検査するため、毎回クエリーも変えて本当に読み直す。
      const documentTime = await page.evaluate('performance.timeOrigin');
      await page.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl) + '&t=' + Date.now() + '-' + (++serial) + '#k=' + encodeURIComponent(latest));
      await page.wait(`performance.timeOrigin !== ${documentTime} && document.readyState === 'complete' && !!window.SPM?.outbox`);
      await page.wait(`${has('いまいる場所で送る')} && !${q('#code')}`);
      await page.wait('!SPM.outbox.isSending()');
    }
    try {
      await mobile(page);
      const nameA = '試験A ' + attack, nameB = '試験Bの受付', nameC = '試験Cの受付';
      const a = await run('startDisaster_', '訓練', nameA, 'メニュー'); assert.equal(a.ok, true);
      await openCurrent(); await click(page, '🗂 あとで場所を決めて送る'); await addPhotos(page, 1, { exif: true });
      const draftA = (await db(page, 'draft'))[0]; assert.equal(draftA.disasterId, a.id); assert.equal(draftA.disasterName, nameA);

      const b = await run('startDisaster_', '訓練', nameB, 'メニュー'); assert.equal(b.ok, true); await openCurrent();
      await page.wait(`!!${q('.previous-drafts')}`);
      assert.match(await page.evaluate(`${q('.previous-drafts')}.className`), /warning/);
      assert.equal(await page.evaluate(`${q('.previous-drafts p')}.textContent`), '前の受付（' + nameA + '）で作りかけの写真が 1 枚あります');
      assert.equal(await page.evaluate(`!!${text('📝 前の続きがあります（1枚）')}`), false);
      assert.equal(await page.evaluate('!!document.querySelector("img[src=x]")'), false, '災害名は文字として表示する');
      await click(page, '🗂 あとで場所を決めて送る'); assert.equal(await page.evaluate("document.querySelectorAll('.photo-card').length"), 0);
      await home(page); await click(page, '今の受付で使う', q('.previous-drafts')); await page.wait(`document.querySelectorAll('.photo-card').length === 1`);
      const adopted = (await db(page, 'draft'))[0]; assert.equal(adopted.id, draftA.id); assert.equal(adopted.disasterId, b.id); assert.equal(adopted.disasterName, nameB); assert.equal(adopted.mode, 'batch');
      await sendPhotos(page); await rowCount(1, b.id); assert.equal(rows(await state(), a.id).length, 0); assert.equal(rows(await state(), b.id)[0]['写真ID'], draftA.id);

      await home(page); await click(page, '🗂 あとで場所を決めて送る'); await addPhotos(page, 1, { exif: true });
      const queuedId = (await db(page, 'draft'))[0].id;
      await network(page, true); await sendPhotos(page);
      const waitingB = (await db(page, 'outbox'))[0]; assert.equal(waitingB.id, queuedId); assert.equal(waitingB.disasterName, nameB);
      // 名前を持たない旧形式の下書きも、別枠の知らせと削除を選べる。
      await click(page, 'ホームに戻る'); await click(page, '🗂 あとで場所を決めて送る'); await addPhotos(page, 1, { exif: true });
      await page.evaluate("SPM.outbox.all('draft').then(async records => { for (const record of records) { delete record.disasterName; await SPM.outbox.saveDraft(record); } })");
      const c = await run('startDisaster_', '訓練', nameC, 'メニュー'); assert.equal(c.ok, true);
      await network(page, false); await openCurrent();
      await page.wait(`${q('#pending-banner')}.textContent.includes('（前の受付の分 1件）')`);
      assert.equal(await page.evaluate(`${q('.previous-drafts p')}.textContent`), '前の受付で作りかけの写真が 1 枚あります');
      await click(page, '⏳ 送信待ち 1件'); await page.wait(`!!${q('.previous-outbox')}`);
      assert.equal(await page.evaluate(`${q('.previous-outbox p')}.textContent`), '前の受付（' + nameB + '）の分 1件');
      const other = (await db(page, 'outbox'))[0]; assert.equal(other.state, 'other'); assert.equal(other.disasterId, b.id);
      // 圏内への復帰、画面復帰、明示的な通常の再送でも、前の受付の分は送らない。
      await page.evaluate("window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); void 0");
      await page.evaluate('spmTest.sendDone = false; void SPM.outbox.send().then(() => { spmTest.sendDone = true; }); true');
      await page.wait('spmTest.sendDone === true && !SPM.outbox.isSending()');
      assert.equal((await db(page, 'outbox'))[0].attempts, other.attempts); assert.equal(rows(await state(), c.id).length, 0); assert.equal(rows(await state(), b.id).length, 1);
      await page.wait('!SPM.outbox.isSending()'); await click(page, '今の受付で送る', q('.previous-outbox'));
      await rowCount(1, c.id); await until(async () => (await db(page, 'outbox')).length === 0);
      const sent = (await db(page, 'history')).find(record => record.id === queuedId); assert.equal(sent.disasterId, c.id); assert.equal(sent.disasterName, nameC);
      assert.equal(rows(await state(), c.id)[0]['写真ID'], queuedId); assert.equal(rows(await state(), b.id).length, 1);

      await home(page); await click(page, '消す', q('.previous-drafts')); await until(async () => (await db(page, 'draft')).length === 0);
      assert.equal(await page.evaluate(`!!${q('.previous-drafts')}`), false);
      // 送信待ちの「消す」も、次の受付に自動送信せず写真を取り除く。
      await click(page, '🗂 あとで場所を決めて送る'); await addPhotos(page, 1, { exif: true });
      await network(page, true); await sendPhotos(page);
      const d = await run('startDisaster_', '訓練', '試験Dの受付', 'メニュー'); assert.equal(d.ok, true);
      await network(page, false); await openCurrent(); await click(page, '⏳ 送信待ち 1件'); await page.wait(`!!${q('.previous-outbox')}`);
      await click(page, '消す', q('.previous-outbox')); await until(async () => (await db(page, 'outbox')).length === 0); await page.wait(has('送信待ちはありません。'));
      assert.equal(rows(await state(), d.id).length, 0); assert.equal(rows(await state(), c.id).length, 1);
      assert.equal(await page.evaluate(`${q('#pending-banner')}.hidden`), true);
    } finally { try { await page.close(); } finally { await admin.bringToFront(); } }
  });
  await check('安全と見やすさ・外部通信・事前確認', async () => {
    await admin.bringToFront();
    await click(admin, '一覧'); assert.ok(await admin.evaluate(`${q('#list-view')}.textContent.includes(${JSON.stringify(attack)})`));
    assert.equal(await admin.evaluate('!!document.querySelector("img[src=x]")'), false);
    await readability(admin, false);
    const latest = (await credentials()).code;
    await post.bringToFront();
    await post.navigate(mock.siteUrl + '/index.html?api=' + encodeURIComponent(mock.gasUrl) + '#k=' + encodeURIComponent(latest)); await post.wait(has('いまいる場所で送る')); await readability(post, true);
    assert.equal(dialogs.filter(event => event.type === 'alert').length, 0, 'alertが0回');
    assert.equal(runtimeErrors.length, 0, '未処理の画面エラーが0件'); assert.equal((await state()).metrics.options, 0, 'OPTIONSが0回');
    assert.equal(interceptionErrors.length, 0, '横取りのエラーが0件：' + interceptionErrors.join('\n')); assert.equal(unexpected.length, 0, '許可していない要求が0件'); assert.ok(tiles.length > 0);
    for (const item of requests) {
      const url = new URL(item.url);
      if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1') assert.ok(tiles.includes(url.href), '外への要求は横取りした地図タイルだけ');
    }
  });
} catch (error) { failed++; console.error('不合格：準備または進行（' + error.message + '）'); }
finally {
  if (browser) try { await browser.close(); } catch (error) { failed++; console.error('不合格：Edgeの終了（' + error.message + '）'); }
  if (mock) try { await mock.close(); } catch (error) { failed++; console.error('不合格：偽GASの終了（' + error.message + '）'); }
  for (const folder of temporary) {
    try { await removeTemp(folder, 'spm-e2e-'); }
    catch (error) { failed++; console.error('不合格：一時フォルダの片付け（' + error.message + '）'); }
  }
  console.log('合計：合格 ' + passed + '件／不合格 ' + failed + '件'); if (failed) process.exitCode = 1;
}

async function makeTemp(kind) {
  const folder = assertTempChild(await fs.mkdtemp(path.join(tmpdir(), 'spm-e2e-' + kind + '-')), 'spm-e2e-');
  temporary.push(folder); return folder;
}
async function download(page, label, extension) {
  const folder = await makeTemp('download');
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder, eventsEnabled: true });
  await click(page, label, dialog);
  const file = await until(async () => (await fs.readdir(folder)).find(name => name.endsWith(extension)), { timeout: 60000, label: extension + 'の保存' });
  return fs.readFile(path.join(folder, file));
}
function parseCsv(source) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = source.charCodeAt(0) === 0xfeff ? 1 : 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === ',') { row.push(value); value = ''; }
    else if (!quoted && char === '\r' && source[i + 1] === '\n') { row.push(value); rows.push(row); row = []; value = ''; i++; }
    else value += char;
  }
  assert.equal(quoted, false); assert.equal(value, ''); return rows;
}
function verifyCsv(data, photos) {
  assert.equal(data.subarray(0, 3).toString('hex'), 'efbbbf'); const source = data.toString('utf8');
  assert.ok(source.endsWith('\r\n')); const parsed = parseCsv(source); assert.equal(parsed.length, photos + 1); assert.equal(parsed[0][0], '受付番号');
  for (const row of parsed) { assert.equal(row.length, 20); for (const cell of row) assert.doesNotMatch(cell, /^[=+\-@\t\r]/); }
}
function readZip(data) {
  const end = data.length - 22; assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10), size = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16), result = new Map(); let cursor = start;
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50); assert.equal(data.readUInt16LE(cursor + 10), 0); assert.ok(data.readUInt16LE(cursor + 8) & 0x800);
    const crc = data.readUInt32LE(cursor + 16), length = data.readUInt32LE(cursor + 24), n = data.readUInt16LE(cursor + 28), extra = data.readUInt16LE(cursor + 30), comment = data.readUInt16LE(cursor + 32), offset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + n).toString('utf8'); assert.ok(!result.has(name)); assert.equal(data.readUInt32LE(offset), 0x04034b50); assert.equal(data.readUInt32LE(offset + 14), crc);
    const begin = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28), bytes = data.subarray(begin, begin + length);
    assert.equal(bytes.length, length); assert.equal(crc32(bytes), crc, name); result.set(name, bytes); cursor += 46 + n + extra + comment;
  }
  assert.equal(cursor, start + size); assert.equal(cursor, end); return result;
}
async function readability(page, smartphone) {
  const result = await page.evaluate(`(() => {
    const visible = node => { const r=node.getBoundingClientRect(), s=getComputedStyle(node);return !!(r.width&&r.height)&&s.visibility!=='hidden'&&!node.closest('[hidden]'); };
    const rgb = value => { const n=value.match(/[\\d.]+/g)?.map(Number)||[];return [n[0]||0,n[1]||0,n[2]||0,n.length>3?n[3]:1]; };
    const blend = (a,b) => [0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1);
    function background(node) { if(!node)return [255,255,255,1];return blend(rgb(getComputedStyle(node).backgroundColor),background(node.parentElement)); }
    const light = c => { const n=c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*n[0]+.7152*n[1]+.0722*n[2]; };
    const ratios=[];
    for(const node of document.querySelectorAll('h1,h2,h3,p,label,button,a.button,input,textarea,select,.badge,.sticky-category')) {
      if(!visible(node)||node.disabled||node.matches('input[type=checkbox],input[type=file]')||!node.textContent.trim()&&!node.matches('input,textarea,select'))continue;
      const bg=background(node),fg=blend(rgb(getComputedStyle(node).color),bg),a=light(bg),b=light(fg);ratios.push({label:node.textContent.trim().slice(0,45)||node.tagName,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
    }
    const buttons=Array.from(document.querySelectorAll('button,a.button,.file-picker')).filter(visible).map(n=>({label:n.textContent.trim().slice(0,40),height:n.getBoundingClientRect().height,locate:n.matches('.map-locate'),category:n.matches('.categories button')}));
    const inputs=Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=file]),textarea,select')).filter(visible).map(n=>({size:parseFloat(getComputedStyle(n).fontSize)}));
    return {ratios,buttons,inputs};
  })()`);
  assert.ok(result.ratios.length > 0);
  for (const item of result.ratios) assert.ok(item.ratio >= 4.5, item.label + 'のコントラスト比：' + item.ratio.toFixed(2));
  if (smartphone) {
    assert.ok(result.buttons.length > 0); for (const item of result.buttons) assert.ok(item.height >= (item.locate ? 40 : item.category ? 44 : 48), item.label + 'の高さ：' + item.height);
    for (const item of result.inputs) assert.ok(item.size >= 16, '入力欄の文字が16px以上');
  }
}
