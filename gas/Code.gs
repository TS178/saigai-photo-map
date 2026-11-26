// 災害写真マップの受け口です。「コード.gs」に全部貼り付けて保存してください。
// 直したら「デプロイを管理 → 編集 → 新しいバージョン」で公開し直してください。
var APP_VERSION = '1.0.0';
var TZ = 'Asia/Tokyo';
var PROP = {
  POST_CODE: '投稿の合言葉', ADMIN_PASS: '管理画面のパスワード', ACCEPT: '投稿の受付',
  ROOT_FOLDER: '（変更しない）写真フォルダID', CURRENT: '（変更しない）受付中の災害ID',
  REV: '（変更しない）更新番号', SALT: '（変更しない）通行証の種'
};
var DISASTER_FIELDS = {
  id: '災害ID', kind: '種別', name: '災害名', start: '開始日時', end: '終了日時', state: '状態',
  folderId: '写真フォルダID', lastNo: '最後の受付番号', posts: '投稿数', photos: '写真枚数', memo: 'メモ'
};
var PHOTO_FIELDS = {
  no: '受付番号', n: '何枚目', of: '枚数', at: '受付日時', shot: '撮影日時', id: '写真ID', pid: 'まとまりID',
  lat: '緯度', lng: '経度', acc: '位置の精度m', src: '位置の取り方', cat: '区分', urgent: '至急',
  note: 'コメント', who: '投稿者', org: '所属', status: '状況', memo: '対応メモ', hidden: '非表示',
  fileId: '写真ファイルID', url: '写真のURL', rev: '更新番号', updated: '更新日時', route: '受付経路',
  ua: '端末', origLat: '元の緯度', origLng: '元の経度'
};
var THUMB_FIELDS = { id: '写真ID', thumb: 'サムネイル' };
var LOG_FIELDS = { at: '日時', kind: '種類', text: '内容', from: 'どこから' };
var SOURCES = { gps: '現在地(GPS)', exif: '写真の位置情報', map: '地図で指定', gmap: 'Googleマップ', landmark: '目印', none: '位置なし', admin: '管理者が修正' };
var DEFAULT_CATEGORIES = [
  { name: '冠水・浸水', color: '#0072B2' }, { name: '土砂崩れ', color: '#8C510A' },
  { name: '河川・水路', color: '#56B4E9' }, { name: '道路・橋の損傷', color: '#E69F00' },
  { name: '倒木・障害物', color: '#009E73' }, { name: '建物被害', color: '#CC79A7' },
  { name: '電柱・電線', color: '#F0E442' }, { name: 'その他', color: '#6B7280' }
];
var SETTING_NAMES = ['地図の初期位置（座標）', '地図の初期の拡大（9〜18）', '10分あたりの受付上限（枚）', '1つの災害の受付上限（枚）', '管理画面の自動更新（秒）', '予備の窓口のURL（LoGoフォームなど・空でよい）', '投稿ページのURL（管理画面が自動で入れる）'];
var REQUEST_ = null;

function nowMs_() { return Date.now(); }
function dateText_(ms, pattern) { return Utilities.formatDate(new Date(ms === undefined ? nowMs_() : ms), TZ, pattern || 'yyyy/MM/dd HH:mm:ss'); }
function codeComplete_() { return typeof SPM_CODE_END !== 'undefined' && SPM_CODE_END === APP_VERSION; }
function cleanText_(s, n) { return String(s === null || s === undefined ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').slice(0, n === undefined ? 49999 : n); }
function asText_(s) { return "'" + cleanText_(s, 49999); }
function normCode_(s) { return String(s === null || s === undefined ? '' : s).normalize('NFKC').replace(/[\s\-‐‑‒–—―−ーｰ]/g, '').toLowerCase(); }
function normPass_(s) { return String(s === null || s === undefined ? '' : s).normalize('NFKC').trim(); }
function accepting_(s) { return ['受付中', 'はい', 'する', 'on', 'true', '1', 'yes', 'open'].indexOf(normPass_(s).toLowerCase()) >= 0; }
function formatCode_(s) { s = String(s || ''); return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4) : s; }
function readCode_(s) {
  var names = ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ'];
  return /^\d{8}$/.test(s) ? s.split('').map(function (c, i) { return names[Number(c)] + (i === 3 ? '、' : ' '); }).join('').trim() : '';
}
function codeKind_(s) { return /^\d+$/.test(normCode_(s)) ? 'digits' : 'text'; }
function fail_(error, message, extra) {
  var messages = { closed: 'いまは投稿の受付をしていません。', code: '合言葉が違うか、変わっています。', locked: 'しばらく確認できません。', auth: 'パスワードが違うか、ログインの有効期限が切れています。もう一度ログインしてください。', bad: '入力を確認してください。', limit: '受付の上限に達しました。少し待ってからやり直してください。', busy: '混み合っています。少し待ってからやり直してください。', notfound: '見つかりませんでした。', server: 'サーバーで問題が起きました。少し待ってからやり直してください。' };
  return Object.assign({ ok: false, error: error, message: message || messages[error] || messages.server }, extra || {});
}
function bad_(message) { throw fail_('bad', message); }
function inRequest_(fn) {
  if (REQUEST_) return fn();
  REQUEST_ = { props: null };
  try { return fn(); } finally { REQUEST_ = null; }
}
function readProps_() {
  if (REQUEST_ && REQUEST_.props) return REQUEST_.props;
  var epoch = cache_().get('spm:propsEpoch');
  var p = PropertiesService.getScriptProperties().getProperties();
  if (REQUEST_) { REQUEST_.props = p; REQUEST_.propsEpoch = epoch; }
  return p;
}
function readLockedProps_() {
  // 通常は一括読取り1回。外側の確認後に別の実行が設定を変えた場合だけ、
  // ロック内で各キーを再取得する（一括getPropertiesは再度呼ばない）。
  if (REQUEST_ && REQUEST_.props && REQUEST_.propsEpoch !== cache_().get('spm:propsEpoch')) {
    var store = PropertiesService.getScriptProperties(), p = {};
    Object.keys(PROP).forEach(function (key) { var value = store.getProperty(PROP[key]); if (value !== null) p[PROP[key]] = value; });
    REQUEST_.props = p; REQUEST_.propsEpoch = cache_().get('spm:propsEpoch');
  }
  return readProps_();
}
function writeProps_(changes) {
  PropertiesService.getScriptProperties().setProperties(changes);
  var epoch = Utilities.getUuid(); cache_().put('spm:propsEpoch', epoch, 21600);
  if (REQUEST_ && REQUEST_.props) { Object.assign(REQUEST_.props, changes); REQUEST_.propsEpoch = epoch; }
}
function cache_() { return CacheService.getScriptCache(); }
function cachedJson_(key) { var s = cache_().get(key); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }
function invalidateConfig_() { cache_().remove('spm:cfg'); }
function spreadsheet_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function headers_(sheet) {
  var width = sheet.getLastColumn();
  return width ? sheet.getRange(1, 1, 1, width).getValues()[0].map(String) : [];
}
function ensureSheet_(name, fields, hidden) {
  var ss = spreadsheet_(), sheet = ss.getSheetByName(name) || ss.insertSheet(name), heads = headers_(sheet);
  Object.keys(fields).forEach(function (key) { if (heads.indexOf(fields[key]) < 0) heads.push(fields[key]); });
  sheet.getRange(1, 1, 1, heads.length).setValues([heads.map(asText_)]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  heads.forEach(function (head, i) { sheet.setColumnWidth(i + 1, /コメント|メモ/.test(head) ? 300 : 155); });
  if (hidden) sheet.hideSheet();
  return sheet;
}
function records_(sheet, fields) {
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues(), heads = rows.shift() || [];
  return rows.map(function (row, i) {
    var obj = { row: i + 2 };
    Object.keys(fields).forEach(function (key) { var col = heads.indexOf(fields[key]); obj[key] = col < 0 || row[col] === undefined ? '' : row[col]; });
    return obj;
  }).filter(function (obj) { return obj.id !== ''; });
}
function cellValue_(v) { return typeof v === 'number' || typeof v === 'boolean' ? v : asText_(v); }
function appendRecord_(sheet, fields, obj) {
  var heads = headers_(sheet), byHead = {};
  Object.keys(fields).forEach(function (key) { byHead[fields[key]] = obj[key] === undefined ? '' : obj[key]; });
  sheet.appendRow(heads.map(function (head) { return cellValue_(Object.prototype.hasOwnProperty.call(byHead, head) ? byHead[head] : ''); }));
}
function writeRecord_(sheet, fields, row, changes) {
  var heads = headers_(sheet);
  Object.keys(changes).forEach(function (key) { var col = heads.indexOf(fields[key]); if (col >= 0) sheet.getRange(row, col + 1).setValue(cellValue_(changes[key])); });
}
function findRecord_(sheet, fields, key, value) {
  var heads = headers_(sheet), col = heads.indexOf(fields[key]), count = sheet.getLastRow() - 1;
  if (col < 0 || count < 1) return null;
  var found = sheet.getRange(2, col + 1, count, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  if (!found) return null;
  var data = sheet.getRange(found.getRow(), 1, 1, heads.length).getValues()[0], obj = { row: found.getRow() };
  Object.keys(fields).forEach(function (k) { var c = heads.indexOf(fields[k]); obj[k] = c < 0 ? '' : data[c]; });
  return obj;
}
function disasters_() { return records_(spreadsheet_().getSheetByName('災害一覧'), DISASTER_FIELDS); }
function disaster_(id) { return findRecord_(spreadsheet_().getSheetByName('災害一覧'), DISASTER_FIELDS, 'id', id); }
function publicDisaster_(d) { return d ? { id: d.id, kind: d.kind, name: d.name, start: d.start, end: d.end, state: d.state, posts: Number(d.posts), photos: Number(d.photos) } : null; }
function integerSetting_(value, fallback, min, max) { var n = Number(value); return value !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback; }
function readSettings_() {
  var sheet = spreadsheet_().getSheetByName('設定'), rows = sheet ? sheet.getDataRange().getValues() : [], cats = [], marks = [], values = {};
  rows.slice(1).forEach(function (r, i) {
    if (r[0] !== '' && r[0] !== undefined) cats.push({ name: cleanText_(r[0], 80), color: /^#[0-9a-f]{6}$/i.test(r[1]) ? r[1] : DEFAULT_CATEGORIES[i % DEFAULT_CATEGORIES.length].color });
    var point = parseLocationText_(r[4]);
    if (r[3] && point && point.lat !== undefined) marks.push({ name: cleanText_(r[3], 80), lat: point.lat, lng: point.lng });
    if (r[7]) values[r[7]] = r[8] === undefined ? '' : r[8];
  });
  var center = parseLocationText_(values[SETTING_NAMES[0]]), zoom = integerSetting_(values[SETTING_NAMES[1]], 13, 9, 18);
  return {
    categories: cats.length ? cats : [{ name: 'その他', color: '#6B7280' }], landmarks: marks,
    map: center && center.lat !== undefined ? { lat: center.lat, lng: center.lng, zoom: zoom } : null,
    limits: { per10min: integerSetting_(values[SETTING_NAMES[2]], 300, 1, 1000000), perDisaster: integerSetting_(values[SETTING_NAMES[3]], 2000, 1, 1000000) },
    pollSeconds: integerSetting_(values[SETTING_NAMES[4]], 20, 2, 3600),
    backupFormUrl: safeHttps_(values[SETTING_NAMES[5]]), postPageUrl: safeHttps_(values[SETTING_NAMES[6]])
  };
}
function getConfig_(fresh) {
  var cfg = fresh ? null : cachedJson_('spm:cfg');
  if (cfg) return cfg;
  var p = readProps_(), ds = disasters_();
  cfg = Object.assign(readSettings_(), { props: p, accepting: accepting_(p[PROP.ACCEPT]), disasters: ds, current: ds.filter(function (d) { return d.id === p[PROP.CURRENT]; })[0] || null });
  cache_().put('spm:cfg', JSON.stringify(cfg), 60);
  return cfg;
}
function randomChars_(alphabet, length) {
  var result = '', ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
  while (result.length < length) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid(), Utilities.Charset.UTF_8);
    bytes.forEach(function (b) { b = (b + 256) % 256; if (b < ceiling && result.length < length) result += alphabet[b % alphabet.length]; });
  }
  return result;
}
function generateCode_(previous) {
  var s;
  do { s = randomChars_('0123456789', 8); } while (/^(\d)\1{7}$/.test(s) || '01234567890123456789'.indexOf(s) >= 0 || '98765432109876543210'.indexOf(s) >= 0 || s === normCode_(previous));
  return s;
}
function generatePass_() {
  var s;
  do { s = randomChars_('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', 12); } while (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/[2-9]/.test(s));
  return s;
}
function token_(kind, cfg, day) {
  var p = cfg.props, value = kind === 'post' ? 'post|' + p[PROP.CURRENT] : 'admin|' + dateText_(day, 'yyyyMMdd');
  var secret = kind === 'post' ? normCode_(p[PROP.POST_CODE]) : normPass_(p[PROP.ADMIN_PASS]);
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret + '|' + p[PROP.SALT])).replace(/=+$/, '');
}
function equalToken_(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  var diff = 0; for (var i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function adminAuthorized_(data, cfg) {
  return !!cfg.props[PROP.ADMIN_PASS] && !!cfg.props[PROP.SALT] && (equalToken_(data.token, token_('admin', cfg)) || equalToken_(data.token, token_('admin', cfg, nowMs_() - 86400000)));
}
function postAuthorized_(data, cfg) { return !!cfg.current && !!cfg.props[PROP.POST_CODE] && !!cfg.props[PROP.SALT] && equalToken_(data.token, token_('post', cfg)); }
function lockInfo_(kind) {
  var until = Number(cache_().get('spm:lock:' + kind) || 0), fail = cachedJson_('spm:fail:' + kind);
  return { until: until > nowMs_() ? until : 0, recentFailures: fail && nowMs_() - fail.first < 600000 ? fail.count : 0 };
}
function locked_(kind) { var lock = lockInfo_(kind); return lock.until ? fail_('locked', null, { retryMinutes: Math.ceil((lock.until - nowMs_()) / 60000) }) : null; }
function failure_(kind, from) {
  // 誤りの計数もロックで直列化し、同時の試行が取りこぼされないようにする。
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return fail_('busy');
  try {
    var active = locked_(kind); if (active) return active;
    var f = cachedJson_('spm:fail:' + kind);
    if (!f || nowMs_() - f.first >= 600000) f = { count: 0, first: nowMs_() };
    f.count++;
    cache_().put('spm:fail:' + kind, JSON.stringify(f), 600);
    if (f.count >= 30) {
      cache_().put('spm:lock:' + kind, String(nowMs_() + 900000), 900);
      log_('ロック', kind === 'post' ? '投稿の確認を一時停止しました。' : '管理の確認を一時停止しました。', from);
      return locked_(kind);
    }
    return fail_(kind === 'post' ? 'code' : 'auth');
  } finally { lock.releaseLock(); }
}
function log_(kind, text, from) {
  var sheet = spreadsheet_().getSheetByName('記録');
  if (!sheet) return;
  // 呼び出し元は固定文だけを渡す。例外・入力・認証情報を記録しない。
  appendRecord_(sheet, LOG_FIELDS, { at: dateText_(), kind: kind, text: text, from: from || 'メニュー' });
}
function nextRev_() {
  var p = readProps_(), rev = Number(p[PROP.REV] || 0) + 1, changes = {};
  changes[PROP.REV] = String(rev); writeProps_(changes); cache_().put('spm:rev', String(rev), 21600); return rev;
}
function mutation_(fn, from) {
  return inRequest_(function () {
    var lock = LockService.getScriptLock();
    try { lock.waitLock(20000); } catch (e) { return fail_('busy'); }
    try {
      var p = readLockedProps_();
      if (REQUEST_.adminToken && !adminAuthorized_({ token: REQUEST_.adminToken }, { props: p })) return fail_('auth');
      return fn(p);
    }
    finally { invalidateConfig_(); lock.releaseLock(); }
  });
}
function safeHttps_(url) { url = cleanText_(url, 301).trim(); return /^https:\/\/[^\s<>"']+$/i.test(url) && url.length <= 300 ? url : ''; }
function writeSetting_(name, value) {
  var sheet = spreadsheet_().getSheetByName('設定'), rows = sheet.getDataRange().getValues(), index = rows.findIndex(function (r) { return r[7] === name; });
  if (index < 0) { index = Math.max(rows.length, 1); sheet.getRange(index + 1, 8).setValue(asText_(name)); }
  sheet.getRange(index + 1, 9).setValue(cellValue_(value));
}
function setup_() {
  return mutation_(function (p) {
    var made = [], changes = {}, ss = spreadsheet_();
    ['災害一覧', '記録'].forEach(function (name) { if (!ss.getSheetByName(name)) made.push(name); ensureSheet_(name, name === '災害一覧' ? DISASTER_FIELDS : LOG_FIELDS); });
    var setting = ss.getSheetByName('設定');
    if (!setting) {
      setting = ss.insertSheet('設定'); made.push('設定');
      setting.getRange(1, 1, 1, 9).setValues([['区分', '色', '', '目印', '座標（Googleマップの数字をそのまま貼る）', '', '', '項目', '値'].map(asText_)]).setFontWeight('bold');
      setting.setFrozenRows(1);
      DEFAULT_CATEGORIES.forEach(function (c, i) { setting.getRange(i + 2, 1, 1, 2).setValues([[asText_(c.name), asText_(c.color)]]); });
      var defaults = ['', 13, 300, 2000, 20, '', ''];
      SETTING_NAMES.forEach(function (name, i) { setting.getRange(i + 2, 8, 1, 2).setValues([[asText_(name), cellValue_(defaults[i])]]); });
      for (var col = 1; col <= 9; col++) setting.setColumnWidth(col, col === 8 ? 360 : 220);
    }
    if (!p[PROP.ROOT_FOLDER]) { changes[PROP.ROOT_FOLDER] = DriveApp.createFolder('災害写真マップ_写真').getId(); made.push('写真フォルダ'); }
    if (!p[PROP.SALT]) changes[PROP.SALT] = Utilities.getUuid() + Utilities.getUuid();
    if (!p[PROP.POST_CODE]) changes[PROP.POST_CODE] = generateCode_('');
    if (!p[PROP.ADMIN_PASS]) changes[PROP.ADMIN_PASS] = generatePass_();
    if (!p[PROP.ACCEPT]) changes[PROP.ACCEPT] = '停止中';
    if (!p[PROP.REV]) changes[PROP.REV] = '0';
    if (Object.keys(changes).length) writeProps_(changes);
    // 過去の投稿シートも、人が見出しを削った場合は末尾へ補う。
    disasters_().forEach(function (d) { ensureSheet_('投稿_' + d.id, PHOTO_FIELDS); ensureSheet_('サムネ_' + d.id, THUMB_FIELDS, true); });
    if (made.length || Object.keys(changes).length) log_('設定', '最初の設定を行いました。', 'メニュー');
    return { ok: true, created: made, postCode: p[PROP.POST_CODE], adminPass: p[PROP.ADMIN_PASS], accepting: accepting_(p[PROP.ACCEPT]) };
  });
}
function startDisaster_(kind, name, from) {
  name = cleanText_(name).trim();
  if (['災害', '訓練'].indexOf(kind) < 0 || !name || name.length > 40) return fail_('bad', '種別と1〜40字の災害名を入れてください。');
  return mutation_(function (p) {
    if (!p[PROP.ROOT_FOLDER] || !p[PROP.SALT]) return fail_('bad', '先に「①最初の設定」を行ってください。');
    var ds = disasters_(), prefix = dateText_(undefined, 'yyyyMMdd') + '-', number = 0;
    ds.forEach(function (d) { if (String(d.id).indexOf(prefix) === 0) number = Math.max(number, Number(String(d.id).slice(prefix.length)) || 0); });
    var id = prefix + (number + 1), sheet = ensureSheet_('災害一覧', DISASTER_FIELDS), at = dateText_();
    var folder = DriveApp.getFolderById(p[PROP.ROOT_FOLDER]).createFolder(id + '_' + (kind === '訓練' ? '訓練_' : '') + name);
    ensureSheet_('投稿_' + id, PHOTO_FIELDS); ensureSheet_('サムネ_' + id, THUMB_FIELDS, true);
    var old = ds.filter(function (d) { return d.id === p[PROP.CURRENT]; })[0];
    if (old) writeRecord_(sheet, DISASTER_FIELDS, old.row, { state: '終了', end: at });
    appendRecord_(sheet, DISASTER_FIELDS, { id: id, kind: kind, name: name, start: at, end: '', state: '受付中', folderId: folder.getId(), lastNo: 0, posts: 0, photos: 0, memo: '' });
    var changes = {}, code = generateCode_(p[PROP.POST_CODE]);
    changes[PROP.CURRENT] = id; changes[PROP.ACCEPT] = '受付中'; changes[PROP.POST_CODE] = code; writeProps_(changes);
    nextRev_(); log_('設定', '新しい災害・訓練の受付を始めました。', from);
    return { ok: true, id: id, newCode: code };
  }, from);
}
function resumeAccepting_(from) {
  return mutation_(function (p) {
    var d = disaster_(p[PROP.CURRENT]); if (!d || d.state === '終了') return fail_('bad', '再開できる災害がありません。');
    var changes = {}; changes[PROP.ACCEPT] = '受付中'; writeProps_(changes);
    writeRecord_(spreadsheet_().getSheetByName('災害一覧'), DISASTER_FIELDS, d.row, { state: '受付中' });
    log_('設定', '投稿の受付を再開しました。', from); return { ok: true };
  }, from);
}
function stopAccepting_(changeCode, from) {
  return mutation_(function (p) {
    var changes = {}, d = disaster_(p[PROP.CURRENT]); changes[PROP.ACCEPT] = '停止中';
    if (changeCode) changes[PROP.POST_CODE] = generateCode_(p[PROP.POST_CODE]);
    writeProps_(changes);
    if (d) writeRecord_(spreadsheet_().getSheetByName('災害一覧'), DISASTER_FIELDS, d.row, { state: '停止中' });
    log_('設定', changeCode ? '合言葉を変えて受付を停止しました。' : '受付を停止しました。', from);
    return changeCode ? { ok: true, newCode: changes[PROP.POST_CODE] } : { ok: true };
  }, from);
}
function setPostCode_(codeOrNull, from) {
  var code = codeOrNull === null || codeOrNull === undefined ? null : normCode_(codeOrNull);
  if (code !== null && !/^[a-z0-9]{4,32}$/.test(code)) return fail_('bad', '合言葉は4〜32文字の英数字で入れてください。');
  return mutation_(function (p) { var changes = {}; changes[PROP.POST_CODE] = code === null ? generateCode_(p[PROP.POST_CODE]) : code; writeProps_(changes); log_('設定', '投稿の合言葉を変更しました。', from); return { ok: true, newCode: changes[PROP.POST_CODE] }; }, from);
}
function setAdminPass_(passOrNull, from) {
  var pass = passOrNull === null || passOrNull === undefined ? generatePass_() : normPass_(passOrNull);
  if (pass.length < 8 || pass.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(pass)) return fail_('bad', 'パスワードは8〜64文字で入れてください。');
  return mutation_(function () { var changes = {}; changes[PROP.ADMIN_PASS] = pass; writeProps_(changes); log_('設定', '管理画面のパスワードを変更しました。', from); return { ok: true, newPass: pass }; }, from);
}
function renameDisaster_(id, name, from) {
  name = cleanText_(name).trim(); if (!name || name.length > 40) return fail_('bad', '災害名は1〜40字で入れてください。');
  return mutation_(function () { var d = disaster_(id); if (!d) return fail_('notfound'); writeRecord_(spreadsheet_().getSheetByName('災害一覧'), DISASTER_FIELDS, d.row, { name: name }); log_('設定', '災害名を変更しました。', from); return { ok: true }; }, from);
}
function validPoint_(lat, lng) { return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180; }
function rounded_(n) { return Math.round(n * 1000000) / 1000000; }
function setMapHome_(lat, lng, zoom, from) {
  if (!validPoint_(lat, lng) || !Number.isInteger(zoom) || zoom < 9 || zoom > 18) return fail_('bad', '座標と9〜18の拡大を入れてください。');
  return mutation_(function () { writeSetting_(SETTING_NAMES[0], rounded_(lat) + ', ' + rounded_(lng)); writeSetting_(SETTING_NAMES[1], zoom); log_('設定', '地図の初期位置を変更しました。', from); return { ok: true }; }, from);
}
function unlock_(from) {
  return mutation_(function () { var kinds = from === '管理画面' ? ['post'] : ['post', 'admin']; kinds.forEach(function (kind) { cache_().remove('spm:lock:' + kind); cache_().remove('spm:fail:' + kind); }); log_('ロック', 'ロックと失敗の数を解除しました。', from); return { ok: true }; }, from);
}

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function apiGuard_(fn) {
  return inRequest_(function () {
    try { return json_(fn()); }
    catch (e) {
      if (e && e.ok === false && e.error) return json_(e);
      try { log_('エラー', '受け口の処理で問題が起きました。', '投稿ページ'); } catch (ignored) { /* 記録不能でもJSONを返す。 */ }
      return json_(fail_('server'));
    }
  });
}
function doGet(e) {
  return apiGuard_(function () { return e && e.parameter && e.parameter.a === 'ping' ? ping_() : { ok: true, app: 'spm', message: '災害写真マップの受け口です' }; });
}
function doPost(e) {
  return apiGuard_(function () {
    var data;
    try { data = JSON.parse(e.postData.contents); } catch (err) { return fail_('bad', '送信したデータを読み取れませんでした。'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail_('bad');
    switch (data.a) {
      case 'ping': return ping_();
      case 'hello': return hello_(data);
      case 'upload': return upload_(data);
      case 'resolve': return resolve_(data);
      case 'login': return login_(data);
      case 'state': return state_(data);
      case 'list': return list_(data);
      case 'photo': return photo_(data);
      case 'update': return update_(data);
      case 'config': return configure_(data);
      default: return fail_('bad', '指定された操作はありません。');
    }
  });
}
function ping_() {
  var cfg = getConfig_();
  return { ok: true, app: 'spm', version: APP_VERSION, codeComplete: codeComplete_(), accepting: cfg.accepting && !!cfg.current, codeKind: codeKind_(cfg.props[PROP.POST_CODE]) };
}
function hello_(data) {
  var cfg = getConfig_();
  if (!cfg.accepting || !cfg.current) return fail_('closed');
  var lock = locked_('post'); if (lock) return lock;
  if (!normCode_(data.code) || normCode_(data.code) !== normCode_(cfg.props[PROP.POST_CODE])) return failure_('post', '投稿ページ');
  return { ok: true, token: token_('post', cfg), version: APP_VERSION, disaster: { id: cfg.current.id, name: cfg.current.name, kind: cfg.current.kind }, categories: cfg.categories, landmarks: cfg.landmarks, map: cfg.map, backupFormUrl: cfg.backupFormUrl, limits: { maxPerPost: 20 } };
}
function webAppUrl_() { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } }
function settings_(cfg) {
  return {
    accepting: cfg.accepting && !!cfg.current, postCode: normCode_(cfg.props[PROP.POST_CODE]), codeKind: codeKind_(cfg.props[PROP.POST_CODE]), codeComplete: codeComplete_(),
    current: cfg.current ? { id: cfg.current.id, name: cfg.current.name, kind: cfg.current.kind, state: cfg.current.state, start: cfg.current.start } : null,
    rootFolderUrl: cfg.props[PROP.ROOT_FOLDER] ? 'https://drive.google.com/drive/folders/' + cfg.props[PROP.ROOT_FOLDER] : '',
    currentFolderUrl: cfg.current ? 'https://drive.google.com/drive/folders/' + cfg.current.folderId : '',
    categories: cfg.categories, landmarks: cfg.landmarks, map: cfg.map, limits: cfg.limits, pollSeconds: cfg.pollSeconds,
    backupFormUrl: cfg.backupFormUrl, postPageUrl: cfg.postPageUrl, webAppUrl: webAppUrl_(), locks: { post: lockInfo_('post'), admin: lockInfo_('admin') }
  };
}
function publicDisasters_(cfg) { return cfg.disasters.slice().reverse().map(publicDisaster_); }
function login_(data) {
  var cfg = getConfig_(), lock = locked_('admin'); if (lock) return lock;
  if (!normPass_(data.pass) || normPass_(data.pass) !== normPass_(cfg.props[PROP.ADMIN_PASS])) return failure_('admin', '管理画面');
  return { ok: true, token: token_('admin', cfg), version: APP_VERSION, codeComplete: codeComplete_(), settings: settings_(cfg), disasters: publicDisasters_(cfg) };
}
function state_(data) {
  var cfg = getConfig_();
  if (!adminAuthorized_(data, cfg)) return fail_('auth');
  return { ok: true, version: APP_VERSION, settings: settings_(cfg), disasters: publicDisasters_(cfg) };
}
function uuidValid_(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function jpegBytes_(text, max, label) {
  if (typeof text !== 'string' || text.length < 4 || text.length > max || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) bad_(label + 'の形式または大きさを確認してください。');
  var bytes;
  try { bytes = Utilities.base64Decode(text); } catch (e) { bad_(label + 'を読み取れませんでした。'); }
  if (bytes.length < 2 || (bytes[0] & 255) !== 255 || (bytes[1] & 255) !== 216) bad_(label + 'を読み取れません。別の写真を選んでください。');
  return bytes;
}
function validatedUpload_(data, cfg) {
  if (!uuidValid_(data.id) || !uuidValid_(data.pid)) bad_('送る写真の情報を確認できませんでした。写真を選び直してください。');
  if (!Number.isInteger(data.n) || !Number.isInteger(data.of) || data.n < 1 || data.of < data.n || data.of > 50) bad_('写真の枚数を確認してください。');
  if (['gps', 'exif', 'map', 'gmap', 'landmark', 'none'].indexOf(data.src) < 0) bad_('位置の取り方を確認してください。');
  if (data.src === 'none') {
    if (data.lat !== null || data.lng !== null) bad_('位置なしの写真は座標を空にしてください。');
  } else if (!validPoint_(data.lat, data.lng)) bad_('緯度と経度を確認してください。');
  if (data.acc !== null && (typeof data.acc !== 'number' || !Number.isFinite(data.acc) || data.acc < 0)) bad_('位置の精度を確認してください。');
  if (typeof data.urgent !== 'boolean') bad_('至急の指定を確認してください。');
  var bytes = jpegBytes_(data.img, 8000000, '写真');
  // 先頭の引用符を含めても1セル50,000字に収める。
  jpegBytes_(data.thumb, 49999, 'サムネイル（49,999字以内）');
  return {
    bytes: bytes, item: {
      id: data.id, pid: data.pid, n: data.n, of: data.of, lat: data.src === 'none' ? '' : rounded_(data.lat), lng: data.src === 'none' ? '' : rounded_(data.lng),
      acc: data.acc === null ? '' : data.acc, src: SOURCES[data.src], shot: cleanText_(data.shot, 40),
      cat: cfg.categories.some(function (c) { return c.name === data.cat; }) ? data.cat : 'その他', urgent: data.urgent,
      note: cleanText_(data.note, 500), who: cleanText_(data.who, 40), org: cleanText_(data.org, 40),
      status: '未確認', memo: '', hidden: false, route: '投稿ページ', ua: deviceKind_(data.ua), origLat: '', origLng: ''
    }
  };
}
function deviceKind_(ua) { ua = String(ua || ''); return /iPhone|iPad|iPod/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android' : /Windows|Macintosh|Linux|PC/i.test(ua) ? 'PC' : 'その他'; }
function limitResult_(cfg, d, alreadyLocked) {
  var bucket = Math.floor(nowMs_() / 600000), key = 'spm:up:' + bucket;
  if (Number(cache_().get(key) || 0) < cfg.limits.per10min && Number(d.photos) < cfg.limits.perDisaster) return null;
  var logKey = 'spm:limit:' + bucket, lock;
  if (!alreadyLocked) { lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) return fail_('busy'); }
  try {
    if (!cache_().get(logKey)) { log_('上限', '写真の受付上限に達しました。', '投稿ページ'); cache_().put(logKey, '1', 1200); }
  } finally { if (lock) lock.releaseLock(); }
  return fail_('limit');
}
function duplicate_(sheet, id, d) {
  var hit = cachedJson_('spm:id:' + id);
  if (hit && hit.d === d) return { ok: true, id: id, no: hit.no, dup: true };
  var found = findRecord_(sheet, PHOTO_FIELDS, 'id', id);
  return found ? { ok: true, id: id, no: Number(found.no), dup: true } : null;
}
function safeFileName_(s, max) { return cleanText_(s).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, max); }
function photoName_(item) {
  var date = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(item.shot) ? item.shot : item.at;
  var stamp = date.slice(0, 10).replace(/\//g, '') + '-' + date.slice(11, 16).replace(':', '');
  return safeFileName_('No' + String(item.no).padStart(4, '0') + '-' + item.n + '_' + stamp + '_' + item.cat + '_' + item.who, 76) + '.jpg';
}
function upload_(data) {
  var cfg = getConfig_();
  if (!cfg.accepting || !cfg.current) return fail_('closed');
  if (!postAuthorized_(data, cfg)) return fail_('code');
  var valid = validatedUpload_(data, cfg), limited = limitResult_(cfg, cfg.current, false);
  if (limited) return limited;
  var dId = cfg.current.id, sheet = spreadsheet_().getSheetByName('投稿_' + dId), duplicate = duplicate_(sheet, data.id, dId);
  if (duplicate) return duplicate;
  var file = DriveApp.getFolderById(cfg.current.folderId).createFile(Utilities.newBlob(valid.bytes, 'image/jpeg', data.id + '.jpg'));
  var lock = LockService.getScriptLock(), committed = false;
  try { lock.waitLock(20000); } catch (e) { file.setTrashed(true); return fail_('busy'); }
  try {
    // ドライブ保存中の受付停止・災害切替・上限到達も、ロック内で読み直して確認する。
    readLockedProps_();
    cfg = getConfig_(true);
    if (!cfg.accepting || !cfg.current) return fail_('closed');
    if (cfg.current.id !== dId || !postAuthorized_(data, cfg)) return fail_('code');
    duplicate = duplicate_(sheet, data.id, dId); if (duplicate) return duplicate;
    limited = limitResult_(cfg, cfg.current, true); if (limited) return limited;
    var same = cachedJson_('spm:pid:' + dId + ':' + data.pid) || findRecord_(sheet, PHOTO_FIELDS, 'pid', data.pid);
    var d = cfg.current, no = same ? Number(same.no) : Number(d.lastNo) + 1, item = valid.item;
    item.no = no; item.at = dateText_(); item.updated = item.at; item.fileId = file.getId(); item.url = file.getUrl(); item.rev = nextRev_();
    appendRecord_(sheet, PHOTO_FIELDS, item);
    // 行が保存済みなら、後段で失敗しても写真そのものは保持する。再送は写真IDで重複判定する。
    committed = true;
    appendRecord_(spreadsheet_().getSheetByName('サムネ_' + dId), THUMB_FIELDS, { id: data.id, thumb: data.thumb });
    writeRecord_(spreadsheet_().getSheetByName('災害一覧'), DISASTER_FIELDS, d.row, { lastNo: Math.max(Number(d.lastNo), no), posts: Number(d.posts) + (same ? 0 : 1), photos: Number(d.photos) + 1 });
    var bucketKey = 'spm:up:' + Math.floor(nowMs_() / 600000);
    cache_().put(bucketKey, String(Number(cache_().get(bucketKey) || 0) + 1), 1200);
    cache_().put('spm:pid:' + dId + ':' + data.pid, JSON.stringify({ no: no }), 21600);
    cache_().put('spm:id:' + data.id, JSON.stringify({ no: no, d: dId }), 21600);
    invalidateConfig_();
  } finally {
    lock.releaseLock();
    if (!committed) file.setTrashed(true);
  }
  file.setName(photoName_(valid.item));
  return { ok: true, id: data.id, no: valid.item.no, dup: false };
}
function publicItem_(obj) {
  var result = {};
  Object.keys(PHOTO_FIELDS).forEach(function (key) { result[key] = obj[key]; });
  result.src = Object.keys(SOURCES).filter(function (key) { return SOURCES[key] === obj.src; })[0] || 'none';
  result.urgent = obj.urgent === true || String(obj.urgent).toUpperCase() === 'TRUE';
  result.hidden = obj.hidden === true || String(obj.hidden).toUpperCase() === 'TRUE';
  return result;
}
function knownDisaster_(cfg, id) { return cfg.disasters.filter(function (d) { return d.id === id; })[0] || null; }
function list_(data) {
  var cfg = getConfig_(); if (!adminAuthorized_(data, cfg)) return fail_('auth');
  var d = knownDisaster_(cfg, data.d); if (!d) return fail_('notfound');
  var since = data.since === undefined ? 0 : Number(data.since);
  if (!Number.isInteger(since) || since < 0) return fail_('bad', '新着を確認できませんでした。「↻ 全部読み直す」を押してください。');
  var storedRev = cache_().get('spm:rev'), rev = Number(storedRev === null ? readProps_()[PROP.REV] || 0 : storedRev);
  if (storedRev === null) cache_().put('spm:rev', String(rev), 21600);
  if (since > 0 && rev <= since) return { ok: true, rev: rev, items: [], thumbs: {} };
  var items = records_(spreadsheet_().getSheetByName('投稿_' + data.d), PHOTO_FIELDS).filter(function (r) { return since === 0 || Number(r.rev) > since; }).map(publicItem_);
  var wanted = {}, thumbs = {}; items.forEach(function (r) { wanted[r.id] = true; });
  if (items.length) records_(spreadsheet_().getSheetByName('サムネ_' + data.d), THUMB_FIELDS).forEach(function (r) { if (wanted[r.id]) thumbs[r.id] = r.thumb; });
  return { ok: true, rev: rev, disaster: publicDisaster_(d), items: items, thumbs: thumbs, serverTime: dateText_() };
}
function photo_(data) {
  var cfg = getConfig_(); if (!adminAuthorized_(data, cfg)) return fail_('auth');
  if (!knownDisaster_(cfg, data.d)) return fail_('notfound');
  if (!uuidValid_(data.id)) return fail_('bad', '写真を確認できませんでした。一覧を読み直して選んでください。');
  var item = findRecord_(spreadsheet_().getSheetByName('投稿_' + data.d), PHOTO_FIELDS, 'id', data.id);
  if (!item) return fail_('notfound');
  var file = DriveApp.getFileById(item.fileId); if (file.isTrashed()) return fail_('notfound');
  return { ok: true, mime: 'image/jpeg', b64: Utilities.base64Encode(file.getBlob().getBytes()), name: file.getName() };
}
function update_(data) {
  var cfg = getConfig_(); if (!adminAuthorized_(data, cfg)) return fail_('auth');
  if (!knownDisaster_(cfg, data.d)) return fail_('notfound');
  if (!uuidValid_(data.pid) || !data.patch || typeof data.patch !== 'object' || Array.isArray(data.patch)) return fail_('bad');
  var patch = data.patch, changes = {};
  if ('status' in patch) { if (['未確認', '確認済', '対応中', '対応済'].indexOf(patch.status) < 0) return fail_('bad', '状況を確認してください。'); changes.status = patch.status; }
  if ('memo' in patch) changes.memo = cleanText_(patch.memo, 1000);
  if ('cat' in patch) { if (!cfg.categories.some(function (c) { return c.name === patch.cat; })) return fail_('bad', '区分を確認してください。'); changes.cat = patch.cat; }
  if ('lat' in patch || 'lng' in patch) { if (!validPoint_(patch.lat, patch.lng)) return fail_('bad', '緯度と経度を両方入れてください。'); changes.lat = rounded_(patch.lat); changes.lng = rounded_(patch.lng); changes.src = SOURCES.admin; }
  var invalidBool = false;
  ['urgent', 'hidden'].forEach(function (key) { if (key in patch) { if (typeof patch[key] !== 'boolean') invalidBool = true; else changes[key] = patch[key]; } });
  if (invalidBool) return fail_('bad', '至急と非表示の指定を確認してください。');
  return mutation_(function () {
    var fresh = getConfig_(true); if (!adminAuthorized_(data, fresh)) return fail_('auth');
    var sheet = spreadsheet_().getSheetByName('投稿_' + data.d), rows = records_(sheet, PHOTO_FIELDS).filter(function (r) { return r.pid === data.pid; });
    if (!rows.length) return fail_('notfound');
    if (Object.keys(changes).length === 0) return { ok: true, rev: Number(readProps_()[PROP.REV] || 0), items: rows.map(publicItem_) };
    var rev = nextRev_(), updated = dateText_();
    rows.forEach(function (r) {
      var edits = Object.assign({}, changes, { rev: rev, updated: updated });
      if ('lat' in changes && r.src !== SOURCES.admin && r.origLat === '' && r.origLng === '') { edits.origLat = r.lat; edits.origLng = r.lng; }
      writeRecord_(sheet, PHOTO_FIELDS, r.row, edits); Object.assign(r, edits);
    });
    return { ok: true, rev: rev, items: rows.map(publicItem_) };
  }, '管理画面');
}
function configure_(data) {
  var cfg = getConfig_(); if (!adminAuthorized_(data, cfg)) return fail_('auth');
  REQUEST_.adminToken = data.token;
  var result;
  switch (data.op) {
    case 'start': result = startDisaster_(data.kind, data.name, '管理画面'); break;
    case 'resume': result = resumeAccepting_('管理画面'); break;
    case 'stop':
      if (typeof data.changeCode !== 'boolean') return fail_('bad', '合言葉を変えるか指定してください。');
      result = stopAccepting_(data.changeCode, '管理画面'); break;
    case 'code': result = setPostCode_(data.code === undefined ? null : data.code, '管理画面'); break;
    case 'rename': result = renameDisaster_(data.d, data.name, '管理画面'); break;
    case 'mapHome': result = setMapHome_(data.lat, data.lng, data.zoom, '管理画面'); break;
    case 'unlock': result = unlock_('管理画面'); break;
    case 'postPageUrl':
      if (typeof data.url !== 'string' || !safeHttps_(data.url)) return fail_('bad', 'https://で始まる投稿ページのリンクを300字以内で入れてください。');
      result = mutation_(function () { writeSetting_(SETTING_NAMES[6], data.url); log_('設定', '投稿ページのURLを変更しました。', '管理画面'); return { ok: true }; }, '管理画面'); break;
    default: return fail_('bad', '指定された設定は変更できません。');
  }
  if (!result.ok) return result;
  cfg = getConfig_(true);
  var response = { ok: true, settings: settings_(cfg), disasters: publicDisasters_(cfg) };
  // configでは合言葉が必要な操作だけに新しい値を返す。
  delete response.settings.postCode;
  if (result.newCode !== undefined) response.newCode = result.newCode;
  invalidateConfig_(); return response;
}

function googleUrl_(text) {
  var match = /^(https?):\/\/([^\/?#]+)([^#]*)?(?:#.*)?$/i.exec(String(text || '').trim());
  if (!match || match[1].toLowerCase() !== 'https') return null;
  var host = match[2].toLowerCase();
  if (['maps.app.goo.gl', 'goo.gl', 'google.com', 'www.google.com', 'maps.google.com', 'google.co.jp', 'www.google.co.jp', 'maps.google.co.jp'].indexOf(host) < 0) return null;
  return { url: match[0], host: host, short: host === 'maps.app.goo.gl' || host === 'goo.gl' };
}
function pointResult_(lat, lng, kind) { lat = Number(lat); lng = Number(lng); return validPoint_(lat, lng) ? { lat: rounded_(lat), lng: rounded_(lng), kind: kind } : null; }
function parseLocationText_(text) {
  if (text === null || text === undefined) return null;
  var s = String(text).normalize('NFKC').trim(), url = googleUrl_(s), m, num = '([+-]?\\d+(?:\\.\\d+)?)';
  if (/^https?:\/\//i.test(s)) {
    if (!url) return null;
    if (url.short) return { needsResolve: true, url: url.url };
    try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return null; }
    var patterns = [new RegExp('!3d' + num + '!4d' + num), new RegExp('@' + num + ',' + num), new RegExp('[?&](?:q|query|ll|center|destination)=\\s*' + num + '\\s*[, ]\\s*' + num), new RegExp('/(?:search|place)/\\s*' + num + '\\s*,\\s*' + num)];
    for (var i = 0; i < patterns.length; i++) { m = patterns[i].exec(s); if (m) return pointResult_(m[1], m[2], 'url'); }
    return null;
  }
  m = new RegExp('^' + num + '\\s*[,\\s]\\s*' + num + '$').exec(s);
  if (m) return pointResult_(m[1], m[2], 'coords');
  m = new RegExp('^(?:北緯|N)\\s*' + num + '\\s*(?:東経|E)\\s*' + num + '$', 'i').exec(s);
  if (m) return pointResult_(m[1], m[2], 'coords');
  m = /^(\d+(?:\.\d+)?)\s*[°度]\s*(\d+(?:\.\d+)?)\s*['′分]\s*(\d+(?:\.\d+)?)\s*["″秒]\s*([NS])\s+(\d+(?:\.\d+)?)\s*[°度]\s*(\d+(?:\.\d+)?)\s*['′分]\s*(\d+(?:\.\d+)?)\s*["″秒]\s*([EW])$/i.exec(s);
  if (!m || Number(m[2]) >= 60 || Number(m[3]) >= 60 || Number(m[6]) >= 60 || Number(m[7]) >= 60) return null;
  return pointResult_((Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * (/S/i.test(m[4]) ? -1 : 1), (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600) * (/W/i.test(m[8]) ? -1 : 1), 'coords');
}
function resolve_(data) {
  var cfg = getConfig_(); if (!postAuthorized_(data, cfg)) return fail_('code');
  if (typeof data.url !== 'string' || data.url.length > 2048) return fail_('bad', 'リンクを確認してください。');
  var url = googleUrl_(data.url); if (!url) return fail_('bad', 'Googleマップの「共有」からコピーしたリンクを入れてください。');
  var follow = url.short;
  for (var i = 0; follow && i < 4; i++) {
    var readable = parseLocationText_(url.url);
    if (readable && readable.lat !== undefined) break;
    var response = UrlFetchApp.fetch(url.url, { followRedirects: false, muteHttpExceptions: true }), status = response.getResponseCode();
    if (status < 300 || status >= 400) break;
    var headers = response.getAllHeaders(), location = '';
    Object.keys(headers).forEach(function (key) { if (key.toLowerCase() === 'location') location = String(headers[key]); });
    if (!location) break;
    if (location.indexOf('//') === 0) location = 'https:' + location;
    else if (location.charAt(0) === '/') location = 'https://' + url.host + location;
    url = googleUrl_(location); if (!url) return fail_('bad', '転送先のリンクは使えません。');
  }
  var point = parseLocationText_(url.url);
  return point && point.lat !== undefined ? { ok: true, lat: point.lat, lng: point.lng } : fail_('notfound', 'リンクから座標を読み取れませんでした。');
}

function htmlEscape_(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function codeHtml_(code) { return '<p class="secret">' + htmlEscape_(formatCode_(code)) + '</p><p>' + htmlEscape_(readCode_(code)) + '</p>'; }
function dialogHtml_(title, body) {
  // スクリプトをdata:の外部リソースとして渡す。インラインのscriptやイベント属性は使わない。
  var script = '(' + dialogClient_.toString() + ')();';
  return '<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font:18px system-ui,sans-serif;color:#1a1a1a;background:#fff;padding:16px}button,input,select{font:inherit;min-height:48px;margin:6px 0;box-sizing:border-box;max-width:100%}button{padding:10px 16px;background:#0b57d0;color:white;border:0;border-radius:12px;display:block;width:100%;font-weight:bold}input{width:100%;padding:8px}.secret{font-size:30px;font-weight:bold;overflow-wrap:anywhere}#result{white-space:pre-wrap;overflow-wrap:anywhere}button:focus-visible,input:focus-visible{outline:3px solid #0b57d0;outline-offset:3px}</style>' +
    '</head><body><h1>' + htmlEscape_(title) + '</h1>' + body + '<p id="result" role="status" aria-live="polite"></p>' +
    '<script src="data:text/javascript;base64,' + Utilities.base64Encode(script, Utilities.Charset.UTF_8) + '"></script></body></html>';
}
function dialogClient_() {
  var result = document.getElementById('result');
  function read(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function show(reply) {
    if (!reply || !reply.ok) { result.textContent = reply && reply.message || '処理できませんでした。'; return; }
    var code = reply.newCode || reply.postCode, pass = reply.newPass || reply.adminPass;
    if (code) {
      var names = ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ'];
      result.textContent = '合言葉：' + (/^\d{8}$/.test(code) ? code.slice(0, 4) + '-' + code.slice(4) + '\n' + code.split('').map(function (c, i) { return names[Number(c)] + (i === 3 ? '、' : ' '); }).join('') : code) + '\n投稿用のリンクとQRを配り直してください。';
    } else result.textContent = '設定しました。';
    if (pass) result.textContent += '\n管理画面のパスワード：' + pass + '\n管理画面に入り直してください。';
    result.classList.add('secret');
  }
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button'); if (!button) return;
    if (button.dataset.kind) {
      document.getElementById('startFields').hidden = false;
      document.getElementById('kind').value = button.dataset.kind;
      document.getElementById('name').focus(); return;
    }
    var fn = button.dataset.call; if (!fn) return;
    var args = [];
    if (fn === 'dlgStart') args = [read('kind'), read('name')];
    if (fn === 'dlgStop') args = [button.dataset.change === 'true'];
    if (fn === 'dlgCode') args = [button.dataset.auto === 'true' ? null : read('code')];
    if (fn === 'dlgAdminPass') args = [button.dataset.auto === 'true' ? null : read('pass')];
    if (fn === 'dlgSetupHome') args = [read('home')];
    button.disabled = true; result.textContent = '処理しています…';
    var runner = google.script.run.withSuccessHandler(function (reply) { button.disabled = false; show(reply); }).withFailureHandler(function () { button.disabled = false; result.textContent = '処理できませんでした。少し待ってからやり直してください。'; });
    runner[fn].apply(runner, args);
  });
}
function showDialog_(title, body) { SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(dialogHtml_(title, body)).setWidth(540).setHeight(680), title); }
function onOpen() {
  SpreadsheetApp.getUi().createMenu('災害写真マップ')
    .addItem('①最初の設定', 'menuSetup').addItem('②受付を始める', 'menuStart').addItem('③受付を止める', 'menuStop')
    .addItem('④投稿の合言葉を変える', 'menuCode').addItem('⑤管理画面のパスワードを変える', 'menuAdminPass')
    .addItem('⑥いまの設定を見る', 'menuCurrent').addItem('⑦ロックを解除', 'menuUnlock').addToUi();
}
function menuSetup() {
  var result = setup_();
  if (!result.ok) { showDialog_('最初の設定', '<p>' + htmlEscape_(result.message) + '</p>'); return; }
  var first = result.created.indexOf('設定') >= 0;
  var body = '<p>' + (first ? '最初の設定ができました。' : '設定済みです。') + '</p><p>受付：' + (result.accepting ? '受付中' : '停止中') + '</p><h2>投稿の合言葉</h2>' + codeHtml_(result.postCode) + '<h2>管理画面のパスワード</h2><p class="secret">' + htmlEscape_(result.adminPass) + '</p>';
  if (first) body += '<label for="home">地図の中心（役場などの位置でGoogleマップを長押しすると出る数字を貼ってください。空でもかまいません）</label><input id="home"><button type="button" data-call="dlgSetupHome">地図の中心を保存する</button>';
  body += '<h2>次にすること</h2><p>Apps Scriptで「デプロイ → 新しいデプロイ → ウェブアプリ」を選びます。「次のユーザーとして実行：自分」「アクセスできるユーザー：全員」で公開し、出たURLをconfig.jsのgasUrlに入れてください。</p>';
  showDialog_('最初の設定', body);
}
function menuStart() {
  showDialog_('受付を始める', '<button type="button" data-kind="災害">新しい災害</button><button type="button" data-kind="訓練">訓練</button><button type="button" data-call="dlgResume">同じ災害で受付を再開</button><div id="startFields" hidden><p>前の災害は終了になり、写真と記録は残ります。</p><input id="kind" type="hidden"><label for="name">災害・訓練の名前（40字まで）</label><input id="name" maxlength="40"><button type="button" data-call="dlgStart">この名前で始める</button></div>');
}
function menuStop() { showDialog_('受付を止める', '<button type="button" data-call="dlgStop" data-change="true">合言葉も変えて止める（おすすめ）</button><button type="button" data-call="dlgStop" data-change="false">合言葉はそのままで止める</button>'); }
function menuCode() { showDialog_('投稿の合言葉を変える', '<button type="button" data-call="dlgCode" data-auto="true">自動で新しくする</button><label for="code">自分で決める（英数字4〜32文字。全角で入れても大丈夫です）</label><input id="code" maxlength="64" autocomplete="off"><button type="button" data-call="dlgCode">入力した合言葉にする</button>'); }
function menuAdminPass() { showDialog_('管理画面のパスワードを変える', '<button type="button" data-call="dlgAdminPass" data-auto="true">自動で新しくする</button><label for="pass">自分で決める（8〜64文字）</label><input id="pass" type="password" maxlength="64" autocomplete="new-password"><button type="button" data-call="dlgAdminPass">入力したパスワードにする</button><p>変更後は管理画面に入り直してください。</p>'); }
function menuCurrent() {
  inRequest_(function () {
    var cfg = getConfig_(), d = cfg.current;
    showDialog_('いまの設定', '<p>受付：' + (cfg.accepting && d ? '受付中' : '停止中') + '</p><p>' + htmlEscape_(d ? d.name + '（' + d.kind + '）開始：' + d.start : '災害は未設定です。') + '</p><h2>投稿の合言葉</h2>' + codeHtml_(cfg.props[PROP.POST_CODE]) + '<p>ウェブアプリ：' + htmlEscape_(webAppUrl_()) + '</p><p>版：' + htmlEscape_(APP_VERSION) + '</p>');
  });
}
function menuUnlock() { showDialog_('ロックを解除', '<p>合言葉やパスワードを何度も間違えて使えなくなった状態を解除し、間違えた回数をリセットします。合言葉やパスワードはそのまま使えます。</p><button type="button" data-call="dlgUnlock">ロックを解除する</button>'); }
function dlgStart(kind, name) { return startDisaster_(kind, name, 'メニュー'); }
function dlgResume() { return resumeAccepting_('メニュー'); }
function dlgStop(changeCode) { return stopAccepting_(changeCode, 'メニュー'); }
function dlgCode(code) { return setPostCode_(code, 'メニュー'); }
function dlgAdminPass(pass) { return setAdminPass_(pass, 'メニュー'); }
function dlgUnlock() { return unlock_('メニュー'); }
function dlgSetupHome(text) { var point = parseLocationText_(text); return !String(text || '').trim() ? { ok: true } : point && point.lat !== undefined ? setMapHome_(point.lat, point.lng, 13, 'メニュー') : fail_('bad', '地図の座標を読み取れませんでした。'); }

var SPM_CODE_END = '1.0.0';
