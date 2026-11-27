import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

// kabu-weather/tests/lib/gas-mock.mjs の vm・プロパティ・模擬通信を基に拡張。
// 通信・ドライブ・シートはすべてメモリ内。実際のサービスには接続しない。
export function createGas({ props = {}, now = Date.parse('2026-11-26T03:00:00Z'), urlRoutes = [], source } = {}) {
  const counters = { propReads: 0, propWrites: 0, sheetReads: 0, sheetWrites: 0, fetches: 0 };
  const control = {
    now: typeof now === 'string' ? Date.parse(now) : now,
    lockAvailable: true, lockHeld: false, released: 0, onWaitLock: null, onCreateFile: null, uiAvailable: true,
    loseVideoReply: false, oauthToken: crypto.randomUUID(),
    webAppUrl: 'https://script.google.com/macros/s/mock/exec'
  };
  const values = new Map(Object.entries(props).map(([key, value]) => [key, String(value)]));
  const logs = [], requests = [];
  const properties = {
    getProperty(key) { counters.propReads++; return values.has(key) ? values.get(key) : null; },
    getProperties() { counters.propReads++; return Object.fromEntries(values); },
    setProperty(key, value) {
      counters.propWrites++;
      const text = String(value);
      if (Buffer.byteLength(text, 'utf8') > 9000) throw new Error('プロパティが9000バイトを超えました。');
      values.set(key, text); return properties;
    },
    setProperties(data, deleteOthers = false) {
      if (deleteOthers) values.clear();
      for (const [key, value] of Object.entries(data)) properties.setProperty(key, value);
      return properties;
    },
    deleteProperty(key) { counters.propWrites++; values.delete(key); return properties; }
  };
  const entries = new Map();
  const cache = {
    entries,
    get(key) {
      const item = entries.get(key);
      if (!item || item.expires <= control.now) { entries.delete(key); return null; }
      return item.value;
    },
    put(key, value, seconds = 600) {
      if (Buffer.byteLength(String(value), 'utf8') > 100 * 1024) throw new Error('キャッシュが100KBを超えました。');
      entries.set(key, { value: String(value), expires: control.now + Math.min(seconds, 21600) * 1000 });
    },
    remove(key) { entries.delete(key); },
    getAll(keys) { return Object.fromEntries(keys.map(key => [key, cache.get(key)]).filter(([, value]) => value !== null)); },
    putAll(data, seconds) { for (const [key, value] of Object.entries(data)) cache.put(key, value, seconds); }
  };
  function interpreted(input) {
    if (typeof input !== 'string') return { value: input === undefined || input === null ? '' : input, formula: '' };
    if (input.length > 50000) throw new Error('セルが50,000字を超えました。');
    if (input.startsWith("'")) return { value: input.slice(1), formula: '' };
    if (input.startsWith('=')) return { value: input, formula: input };
    if (/^[+-]?\d+(?:\.\d+)?$/.test(input)) return { value: Number(input), formula: '' };
    // 引用符がない値は、Sheetsと同様に数字や日付に変わり得る。
    if (/^\d{4}\/\d{1,2}\/\d{1,2}(?: \d{2}:\d{2}:\d{2})?$/.test(input)) return { value: new Date(input.replace(/\//g, '-') + (input.includes(' ') ? '+09:00' : 'T00:00:00+09:00')), formula: '' };
    if (/^\d{1,2}-\d{1,2}$/.test(input)) return { value: new Date(new Date(control.now).getUTCFullYear() + '-' + input + 'T00:00:00+09:00'), formula: '' };
    return { value: input, formula: '' };
  }
  function range(sheet, row, column, numRows = 1, numColumns = 1) {
    if (![row, column, numRows, numColumns].every(n => Number.isInteger(n) && n > 0)) throw new Error('範囲が不正です。');
    const result = {
      getRow: () => row, getColumn: () => column, getNumRows: () => numRows, getNumColumns: () => numColumns,
      getValues() {
        counters.sheetReads++;
        return Array.from({ length: numRows }, (_, r) => Array.from({ length: numColumns }, (_, c) => sheet.data[row + r - 1]?.[column + c - 1] ?? ''));
      },
      setValues(rows) {
        if (rows.length !== numRows || rows.some(r => r.length !== numColumns)) throw new Error('範囲と値の大きさが違います。');
        counters.sheetWrites++;
        rows.forEach((r, ri) => r.forEach((input, ci) => {
          const rr = row + ri, cc = column + ci, parsed = interpreted(input);
          while (sheet.data.length < rr) sheet.data.push([]);
          while (sheet.data[rr - 1].length < cc) sheet.data[rr - 1].push('');
          sheet.data[rr - 1][cc - 1] = parsed.value;
          const key = rr + ':' + cc;
          if (parsed.formula) sheet.formulas.set(key, parsed.formula); else sheet.formulas.delete(key);
          sheet.writes.push({ row: rr, col: cc, input, value: parsed.value, formula: parsed.formula });
        }));
        return result;
      },
      getValue() { return result.getValues()[0][0]; },
      setValue(value) { return result.setValues([[value]]); },
      setFontWeight(weight) { sheet.fontWeights.push({ row, column, numRows, numColumns, weight }); return result; },
      createTextFinder(text) { return finder(sheet, result, text); }
    };
    return result;
  }
  function finder(sheet, area, text) {
    let whole = false, cursor = 0, matchCase = false;
    function matches() {
      counters.sheetReads++;
      const found = [], needle = matchCase ? String(text) : String(text).toLowerCase();
      for (let r = area.getRow(); r < area.getRow() + area.getNumRows(); r++) {
        for (let c = area.getColumn(); c < area.getColumn() + area.getNumColumns(); c++) {
          let value = String(sheet.data[r - 1]?.[c - 1] ?? '');
          if (!matchCase) value = value.toLowerCase();
          if (whole ? value === needle : value.includes(needle)) found.push(range(sheet, r, c));
        }
      }
      return found;
    }
    const result = {
      matchEntireCell(value) { whole = value; return result; },
      matchCase(value) { matchCase = value; return result; },
      findAll() { return matches(); },
      findNext() { const all = matches(); return all.length ? all[cursor++ % all.length] : null; }
    };
    return result;
  }
  const sheets = new Map();
  function makeSheet(name) {
    if (sheets.has(name)) throw new Error('同じ名前のシートがあります。');
    const sheet = {
      data: [], writes: [], formulas: new Map(), fontWeights: [], widths: new Map(), frozenRows: 0, hidden: false,
      getName: () => name,
      getLastRow() { let n = sheet.data.length; while (n && !sheet.data[n - 1].some(v => v !== '' && v !== null && v !== undefined)) n--; return n; },
      getLastColumn() { return sheet.data.reduce((max, row) => Math.max(max, row.reduce((last, value, index) => value !== '' && value !== null && value !== undefined ? index + 1 : last, 0)), 0); },
      getRange: (r, c, nr = 1, nc = 1) => range(sheet, r, c, nr, nc),
      getDataRange: () => range(sheet, 1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn())),
      appendRow(row) { range(sheet, sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]); return sheet; },
      setFrozenRows(n) { sheet.frozenRows = n; return sheet; },
      hideSheet() { sheet.hidden = true; return sheet; },
      isSheetHidden: () => sheet.hidden,
      setColumnWidth(col, width) { sheet.widths.set(col, width); return sheet; },
      createTextFinder: text => finder(sheet, sheet.getDataRange(), text)
    };
    sheets.set(name, sheet); return sheet;
  }
  const spreadsheet = {
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: makeSheet,
    getSheets: () => [...sheets.values()],
    deleteSheet(sheet) { sheets.delete(sheet.getName()); },
    getId: () => 'mock-spreadsheet'
  };
  const ui = {
    menus: [], alerts: [], prompts: [], promptAnswers: [], dialogs: [],
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' }, Button: { OK: 'OK', CANCEL: 'CANCEL' },
    createMenu(name) {
      const menu = { name, items: [], addItem(label, fn) { menu.items.push({ label, fn }); return menu; }, addSeparator() { return menu; }, addToUi() { ui.menus.push(menu); return menu; } };
      return menu;
    },
    alert(...args) { ui.alerts.push(args); return ui.Button.OK; },
    prompt(...args) {
      ui.prompts.push(args); const answer = ui.promptAnswers.shift() || {};
      return { getResponseText: () => answer.text || '', getSelectedButton: () => answer.button || ui.Button.OK };
    },
    showModalDialog(html, title) { ui.dialogs.push({ html: html.getContent(), width: html.width, height: html.height, title }); }
  };
  const unsigned = bytes => Buffer.from(Array.from(bytes, b => b & 255));
  const signed = buffer => [...buffer].map(b => b > 127 ? b - 256 : b);
  function blob(bytes, mime = 'application/octet-stream', name = '') {
    const data = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : unsigned(bytes);
    const result = {
      getBytes: () => signed(data), getContentType: () => mime, getName: () => name,
      setName(value) { name = String(value); return result; },
      getDataAsString: (charset = 'utf8') => data.toString(charset === 'UTF-8' ? 'utf8' : charset)
    };
    return result;
  }
  const drive = { folders: new Map(), files: new Map(), sessions: new Map(), expireSession(url) { required(drive.sessions, url, '送信先').expired = true; } };
  function folder(name, parent = null, id = 'folder-' + crypto.randomUUID()) {
    const result = {
      id, name, parent, children: [], fileIds: [],
      getId: () => id, getName: () => name, getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      createFolder(childName) { const child = folder(String(childName), id); result.children.push(child.getId()); return child; },
      createFile(data) {
        const fileId = 'file-' + crypto.randomUUID(); let fileName = data.getName(), trashed = false;
        const file = {
          folderId: id, createdUnderLock: control.lockHeld,
          getId: () => fileId, getName: () => fileName, setName(value) { fileName = String(value); return file; },
          setTrashed(value) { trashed = value; return file; }, isTrashed: () => trashed,
          getBlob: () => blob(data.getBytes(), data.getContentType(), fileName),
          getSize: () => data.getBytes().length, getMimeType: () => data.getContentType(),
          getUrl: () => 'https://drive.google.com/file/d/' + fileId + '/view'
        };
        drive.files.set(fileId, file); result.fileIds.push(fileId);
        if (control.onCreateFile) control.onCreateFile(file);
        return file;
      }
    };
    drive.folders.set(id, result); return result;
  }
  drive.root = folder('マイドライブ', null, 'root');
  function required(map, id, label) { if (!map.has(id)) throw new Error(label + 'がありません。'); return map.get(id); }
  function formatDate(date, timeZone, pattern) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
    const tokens = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second };
    return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, token => tokens[token]);
  }
  function fetch(url, options = {}) {
    counters.fetches++; const request = { url, ...options }; requests.push(request);
    let reply;
    if (typeof urlRoutes === 'function') reply = urlRoutes(request, requests);
    else {
      const route = urlRoutes.find(item => typeof item.url === 'function' ? item.url(url) : item.url instanceof RegExp ? item.url.test(url) : item.url === url);
      reply = route ? (typeof route.response === 'function' ? route.response(request, requests) : route.response || route) : undefined;
    }
    if (reply === undefined) reply = driveFetch(url, options) || { status: 404, body: '模擬応答なし' };
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error('模擬応答がありません。');
    return {
      getResponseCode: () => reply.status ?? 200,
      getHeaders: () => ({ ...reply.headers }), getAllHeaders: () => ({ ...reply.headers }),
      getContentText: () => typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}),
      getBlob: () => blob(reply.bytes ?? Buffer.from(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})), reply.mime || 'application/octet-stream')
    };
  }
  function driveFetch(url, options) {
    const header = name => Object.entries(options.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const isDrive = url.startsWith('https://www.googleapis.com/upload/drive/') || url.startsWith('https://www.googleapis.com/drive/');
    if (!isDrive) return null;
    if (header('Authorization') !== 'Bearer ' + control.oauthToken) return { status: 401 };
    const method = (options.method || 'get').toLowerCase();
    if (method === 'post' && url === 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id') {
      const meta = JSON.parse(options.payload), size = Number(header('X-Upload-Content-Length')), mime = header('X-Upload-Content-Type');
      if (!Number.isSafeInteger(size) || size < 1 || !drive.folders.has(meta.parents?.[0])) return { status: 400 };
      const location = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' + crypto.randomUUID();
      drive.sessions.set(location, { url: location, size, mime, meta, bytes: Buffer.alloc(0), fileId: null, expired: false, expires: control.now + 7 * 86400000 });
      return { status: 200, headers: { Location: location } };
    }
    if (method === 'put' && drive.sessions.has(url)) {
      const session = drive.sessions.get(url);
      if (session.expired || session.expires <= control.now) return { status: 410 };
      const received = () => session.fileId ? { status: 200, body: { id: session.fileId } } : { status: 308, headers: session.bytes.length ? { Range: 'bytes=0-' + (session.bytes.length - 1) } : {} };
      const contentRange = String(header('Content-Range') || '');
      if (contentRange === 'bytes */' + session.size) return received();
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!match) return { status: 400 };
      if (session.fileId) return received();
      const [, start, end, total] = match.map(Number), bytes = unsigned(options.payload || []);
      if (total !== session.size || start !== session.bytes.length) return { status: 409 };
      if (end !== start + bytes.length - 1 || end >= total || !bytes.length || end + 1 < total && bytes.length % (256 * 1024) !== 0) return { status: 400 };
      session.bytes = Buffer.concat([session.bytes, bytes]);
      if (session.bytes.length === session.size) {
        const file = drive.folders.get(session.meta.parents[0]).createFile(blob(session.bytes, session.mime, session.meta.name));
        session.fileId = file.getId();
      }
      if (control.loseVideoReply) { control.loseVideoReply = false; throw new Error('模擬の動画応答消失'); }
      return received();
    }
    const media = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\?alt=media$/.exec(url);
    if (method === 'get' && media) {
      const file = drive.files.get(decodeURIComponent(media[1]));
      if (!file || file.isTrashed()) return { status: 404 };
      const bytes = unsigned(file.getBlob().getBytes()), range = /^bytes=(\d+)-(\d+)$/.exec(String(header('Range') || ''));
      if (!range) return { status: 200, bytes, mime: file.getMimeType() };
      const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
      if (start > end || start >= bytes.length) return { status: 416 };
      return { status: 206, bytes: bytes.subarray(start, end + 1), mime: file.getMimeType(), headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length } };
    }
    return null;
  }
  class MockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [control.now])); }
    static now() { return control.now; }
  }
  function textOutput(content) {
    const result = { mimeType: '', getContent: () => String(content), setMimeType(value) { result.mimeType = value; return result; } }; return result;
  }
  function htmlOutput(content) {
    const result = { width: 0, height: 0, getContent: () => String(content), setWidth(value) { result.width = value; return result; }, setHeight(value) { result.height = value; return result; } }; return result;
  }
  function takeLock() {
    if (control.onWaitLock) { const hook = control.onWaitLock; control.onWaitLock = null; hook(); }
    if (!control.lockAvailable || control.lockHeld) return false;
    control.lockHeld = true; return true;
  }
  const context = vm.createContext({
    Date: MockDate,
    PropertiesService: { getScriptProperties: () => properties },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, getUi() { if (!control.uiAvailable) throw new Error('エディタではUIを取得できません。'); return ui; }, flush() {} },
    DriveApp: { getRootFolder: () => drive.root, createFolder: name => drive.root.createFolder(name), getFolderById: id => required(drive.folders, id, 'フォルダ'), getFileById: id => required(drive.files, id, '写真') },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({
      waitLock() { if (!takeLock()) throw new Error('模擬のロック待ち失敗'); },
      tryLock: () => takeLock(), releaseLock() { control.lockHeld = false; control.released++; }, hasLock: () => control.lockHeld
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(), formatDate,
      computeDigest: (algorithm, value) => signed(crypto.createHash(algorithm).update(typeof value === 'string' ? value : unsigned(value)).digest()),
      computeHmacSha256Signature: (value, key) => signed(crypto.createHmac('sha256', key).update(value, 'utf8').digest()),
      base64Decode: value => signed(Buffer.from(value, 'base64')),
      base64Encode: value => (typeof value === 'string' ? Buffer.from(value, 'utf8') : unsigned(value)).toString('base64'),
      base64EncodeWebSafe: value => (typeof value === 'string' ? Buffer.from(value, 'utf8') : unsigned(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      newBlob: blob
    },
    ContentService: { createTextOutput: textOutput, MimeType: { JSON: 'application/json' } },
    HtmlService: { createHtmlOutput: htmlOutput },
    ScriptApp: { getService: () => ({ getUrl: () => control.webAppUrl }), getOAuthToken: () => control.oauthToken },
    UrlFetchApp: { fetch },
    Session: { getScriptTimeZone: () => 'Asia/Tokyo', getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => 'mock@example.invalid' }) },
    console: Object.fromEntries(['log', 'warn', 'error', 'info'].map(level => [level, (...args) => logs.push({ level, text: args.map(String).join(' ') })]))
  });
  vm.runInContext(source ?? fs.readFileSync(new URL('../../gas/Code.gs', import.meta.url), 'utf8'), context, { filename: 'gas/Code.gs' });
  function call(fnName, ...args) {
    if (typeof context[fnName] !== 'function') throw new Error('指定された関数がありません。');
    const value = context[fnName](...args);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  return {
    context, props: properties, control, sheets, drive, cache, ui, logs, requests, counters,
    call,
    doPost: obj => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(obj) } }).getContent()),
    doGet: params => JSON.parse(context.doGet({ parameter: params || {} }).getContent()),
    evaluate: code => vm.runInContext(code, context)
  };
}
