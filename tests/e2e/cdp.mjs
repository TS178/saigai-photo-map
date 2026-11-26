// Node 24 標準機能だけで Edge を操作する。import だけでは起動しない。
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(probe, {timeout = 15000, interval = 80, label = '条件'} = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; }
    catch (error) { last = error; }
    await delay(interval);
  }
  throw new Error(`${label}を待って時間切れ${last ? `: ${last.message}` : ''}`);
}
export async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
export function run(command, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {windowsHide: true, stdio: 'ignore'});
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command}: timeout`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
export function assertTempChild(target, prefix) {
  const absolute = path.resolve(target), parent = path.resolve(tmpdir());
  if (path.dirname(absolute).toLowerCase() !== parent.toLowerCase() || !path.basename(absolute).startsWith(prefix)) {
    throw new Error(`一時フォルダの範囲外です: ${absolute}`);
  }
  return absolute;
}
export async function removeTemp(target, prefix) {
  const absolute = assertTempChild(target, prefix);
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rm(absolute, {recursive: true, force: true, maxRetries: 0}); return; }
    catch (error) { if (attempt === 19) throw error; await delay(300); }
  }
}
export async function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const code = await run('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)]);
  if (code !== 0 && child.exitCode === null && child.signalCode === null) {
    // 親が終了した直後の taskkill の「見つからない」は許容する。
    await delay(100);
    if (child.exitCode === null && child.signalCode === null) throw new Error(`taskkill失敗: PID ${child.pid}, code ${code}`);
  }
}
export async function killProfile(profile) {
  // パスを正規表現の文字として解釈せず照合する。引数全体の引用にも対応する。
  const full = path.resolve(profile);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'
$profilePath = ${quote(full)}
Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" | ForEach-Object {
  $line = [string]$_.CommandLine
  $pattern = '(?i)' + [regex]::Escape($profilePath) + '(?=["\\s]|$)'
  if ($line -match $pattern) {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
    catch { if (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) { throw } }
  }
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const code = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  if (code !== 0) throw new Error(`Edgeプロフィールの終了処理に失敗: ${full}`);
}
async function edgePath() {
  const candidates = process.env.SPM_EDGE_PATH ? [process.env.SPM_EDGE_PATH] : [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  for (const name of candidates) { try { await access(name); return name; } catch { /* 次の候補 */ } }
  throw new Error('Edgeがありません。SPM_EDGE_PATHにmsedge.exeのフルパスを指定してください');
}

export class CDP {
  constructor(ws) {
    this.ws = ws; this.serial = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    });
    ws.addEventListener('close', () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP接続が閉じました')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('CDP接続時間切れ')); }, 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP接続失敗')); }, {once: true});
    });
    return new CDP(ws);
  }
  on(method, listener) {
    const list = this.listeners.get(method) || new Set(); list.add(listener); this.listeners.set(method, list);
    return () => list.delete(listener);
  }
  send(method, params = {}, timeout = 15000) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP時間切れ: ${method}`)); }, timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.ws.send(JSON.stringify({id, method, params})); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() { this.ws.close(); }
}

export class Page {
  constructor(cdp, id, browser, context) { this.cdp = cdp; this.id = id; this.browser = browser; this.context = context; this.closed = false; }
  async bringToFront() {
    await this.cdp.send('Page.bringToFront');
    await this.wait('document.visibilityState === "visible"');
  }
  async viewport(width, height) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
    await this.wait(`innerWidth === ${width} && innerHeight === ${height}`);
  }
  async evaluate(expression) {
    const result = await this.cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  wait(expression, options = {}) { return until(() => this.evaluate(expression), {...options, label: options.label || expression}); }
  async navigate(url) {
    // #kを起動直後に消す投稿ページにも対応する。
    let loaded = false;
    const off = this.cdp.on('Page.loadEventFired', () => { loaded = true; });
    try {
      const result = await this.cdp.send('Page.navigate', {url});
      if (result.errorText) throw new Error(result.errorText);
      if (result.loaderId) await until(() => loaded, {label: 'ページの読み込み'});
      const expected = new URL(url); expected.hash = '';
      await this.wait(`location.href.split('#')[0] === ${JSON.stringify(expected.href)} && document.readyState === 'complete'`);
    } finally { off(); }
  }
  async click(expression) {
    const {x, y} = await this.evaluate(`(() => { const e = (${expression});
      if (!e || e.disabled || e.closest('[hidden]')) throw new Error('押せない要素: ' + ${JSON.stringify(expression)});
      e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect();
      if (!r.width || !r.height) throw new Error('非表示の要素'); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await this.cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
    await this.cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  }
  async fill(expression, value) {
    await this.evaluate(`(() => { const e = (${expression}); if (!e) throw new Error('入力欄がない');
      e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  }
  request(route, method = 'GET', body) {
    return this.evaluate(`(async () => { const r = await fetch(${JSON.stringify(route)}, {
      method:${JSON.stringify(method)}, headers:{'Content-Type':'application/json'},
      body:${body === undefined ? 'undefined' : `JSON.stringify(${JSON.stringify(body)})`}});
      return {status:r.status,body:await r.json()}; })()`);
  }
  async screenshot(file) {
    const {data} = await this.cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    const {writeFile} = await import('node:fs/promises');
    await writeFile(file, Buffer.from(data, 'base64'));
  }
  async close() {
    if (this.closed) return;
    await this.browser.cdp.send('Target.closeTarget', {targetId: this.id});
    this.closed = true; this.cdp.close();
    if (this.context) await this.browser.cdp.send('Target.disposeBrowserContext', {browserContextId: this.context});
  }
}

export async function launchEdge({origin, onRequest = () => {}, onPage = async () => {}}) {
  if (process.platform !== 'win32') throw new Error('この画面確認はWindows用です');
  const executable = await edgePath();
  const profile = await mkdtemp(path.join(tmpdir(), 'edge-prof-spm-'));
  let child, cdp, closed = false;
  const pages = [];
  async function close() {
    if (closed) return; closed = true;
    for (const page of pages) page.cdp.close(); cdp?.close();
    const errors = [];
    // 順番を守り、親が既に終了していてもプロフィールによる探索を省略しない。
    try { await killTree(child); } catch (error) { errors.push(error); }
    try { await killProfile(profile); } catch (error) { errors.push(error); }
    try { await removeTemp(profile, 'edge-prof-spm-'); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Edgeの終了処理に失敗しました');
  }
  try {
    const port = await freePort(), endpoint = `http://127.0.0.1:${port}`;
    child = spawn(executable, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', 'about:blank'],
      {windowsHide: true, stdio: 'ignore'});
    let spawnError; child.on('error', error => { spawnError = error; });
    const version = await until(async () => {
      if (spawnError) throw spawnError;
      const r = await fetch(`${endpoint}/json/version`, {signal: AbortSignal.timeout(1000)}); return r.ok && r.json();
    }, {timeout: 20000, label: 'Edgeの起動'});
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const browser = {profile, cdp, close, pages, async newPage(route, {isolated = false} = {}) {
      // HTTP/1.1の接続枠を1本残す。背景でSSEが止まる画面も枚数に含める。
      if (!isolated && pages.filter(page => !page.closed && !page.context).length >= 5) {
        throw new Error('同じブラウザ領域は5画面までです。画面を閉じるか isolated: true を指定してください');
      }
      const context = isolated ? (await cdp.send('Target.createBrowserContext')).browserContextId : undefined;
      const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank', ...(context ? {browserContextId: context} : {})});
      const target = await until(async () => {
        const r = await fetch(`${endpoint}/json/list`, {signal: AbortSignal.timeout(2000)});
        return (await r.json()).find(item => item.id === targetId && item.webSocketDebuggerUrl);
      }, {label: '確認用ページ'});
      const connection = await CDP.connect(target.webSocketDebuggerUrl), page = new Page(connection, targetId, browser, context);
      pages.push(page);
      connection.on('Network.requestWillBeSent', event => onRequest({page: targetId, url: event.request.url}));
      await connection.send('Network.enable'); await connection.send('Page.enable'); await connection.send('Runtime.enable');
      await connection.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 900, deviceScaleFactor: 1, mobile: false});
      // 通信の横取りと端末設定を、最初の読み込みより前に必ず入れる。
      await onPage(page);
      await page.navigate(new URL(route, origin).href); return page;
    }};
    return browser;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Edge起動・後片付け失敗'); }
    throw error;
  }
}
