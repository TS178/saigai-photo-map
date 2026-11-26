import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGas } from './lib/gas-mock.mjs';

// 認証の値はすべてmockのUUID・GASの生成処理から得る。実サービスには接続しない。
const codeCases = JSON.parse(fs.readFileSync(new URL('./fixtures/codes.json', import.meta.url), 'utf8'));
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]).toString('base64');
function uuid(gas) { return gas.context.Utilities.getUuid(); }
function prepared(options = {}) {
  const gas = createGas(options);
  assert.equal(gas.call('setup_').ok, true);
  const start = gas.call('startDisaster_', '災害', '試験の大雨', 'メニュー');
  assert.equal(start.ok, true);
  const props = gas.props.getProperties(), P = gas.context.PROP;
  const hello = gas.doPost({ a: 'hello', code: props[P.POST_CODE] });
  const login = gas.doPost({ a: 'login', pass: props[P.ADMIN_PASS] });
  assert.equal(hello.ok, true); assert.equal(login.ok, true);
  return { gas, d: start.id, code: props[P.POST_CODE], pass: props[P.ADMIN_PASS], postToken: hello.token, adminToken: login.token };
}
function payload(env, overrides = {}) {
  return {
    a: 'upload', token: env.postToken, id: uuid(env.gas), pid: uuid(env.gas), n: 1, of: 1,
    lat: 37.04123456, lng: 136.77901234, acc: 12, src: 'gps', shot: '2027/07/01 14:32:00',
    cat: '冠水・浸水', urgent: false, note: '道路を確認', who: '山田', org: '消防団', ua: 'iPhone', img: jpeg, thumb: jpeg,
    ...overrides
  };
}
function rows(gas, name) {
  const sheet = gas.sheets.get(name); assert.ok(sheet, 'シートがある：' + name);
  const [heads, ...data] = sheet.data;
  return data.filter(row => row.some(value => value !== '')).map(row => Object.fromEntries(heads.map((head, index) => [head, row[index] ?? ''])));
}
function liveFiles(gas) { return [...gas.drive.files.values()].filter(file => !file.isTrashed()); }
function list(env, d = env.d, since = 0) { return env.gas.doPost({ a: 'list', token: env.adminToken, d, since }); }
function config(env, data) { return env.gas.doPost({ a: 'config', token: env.adminToken, ...data }); }
function update(env, pid, patch, d = env.d) { return env.gas.doPost({ a: 'update', token: env.adminToken, d, pid, patch }); }
function changeSetting(gas, name, value) {
  const sheet = gas.sheets.get('設定'), index = sheet.data.findIndex(row => row[7] === name);
  assert.ok(index >= 0); sheet.getRange(index + 1, 9).setValue(typeof value === 'string' ? gas.call('asText_', value) : value);
  gas.cache.remove('spm:cfg');
}
function assertError(reply, error) { assert.equal(reply.ok, false); assert.equal(reply.error, error); assert.equal(typeof reply.message, 'string'); assert.ok(reply.message.length); }
function fullWidth(text) { return text.replace(/[0-9A-Za-z]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)); }
function loginAgain(env) { return env.gas.doPost({ a: 'login', pass: env.pass }); }

test('1 最初の設定は3回でも同じシート・フォルダ・認証情報を保つ', () => {
  const gas = createGas(), first = gas.call('setup_'), before = gas.props.getProperties();
  const sheetNames = [...gas.sheets.keys()], folderIds = [...gas.drive.folders.keys()];
  const second = gas.call('setup_'), third = gas.call('setup_');
  assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(third.ok, true);
  assert.deepEqual(second.created, []); assert.deepEqual(third.created, []);
  assert.deepEqual([...gas.sheets.keys()], sheetNames); assert.deepEqual([...gas.drive.folders.keys()], folderIds);
  assert.deepEqual(gas.props.getProperties(), before);
  const P = gas.context.PROP;
  assert.match(before[P.POST_CODE], /^\d{8}$/); assert.doesNotMatch(before[P.POST_CODE], /^(\d)\1+$/);
  assert.equal('01234567890123456789'.includes(before[P.POST_CODE]), false);
  assert.match(before[P.ADMIN_PASS], /^[A-HJ-NP-Za-km-z2-9]{12}$/);
  assert.match(before[P.ADMIN_PASS], /[A-Z]/); assert.match(before[P.ADMIN_PASS], /[a-z]/); assert.match(before[P.ADMIN_PASS], /[2-9]/);
  assert.equal(before[P.ACCEPT], '停止中'); assert.equal(before[P.REV], '0');
  for (const sheet of gas.sheets.values()) { assert.equal(sheet.frozenRows, 1); assert.ok(sheet.fontWeights.some(item => item.weight === 'bold')); }
  const reads = gas.counters.propReads; gas.call('setup_'); assert.equal(gas.counters.propReads - reads, 1);
});

test('2 pingは版・受付状態・種別を返し、停止中のhelloは先にclosedを返す', () => {
  const gas = createGas(); gas.call('setup_');
  const P = gas.context.PROP, code = gas.props.getProperty(P.POST_CODE), ping = gas.doGet({ a: 'ping' });
  assert.deepEqual(ping, { ok: true, app: 'spm', version: '1.0.0', codeComplete: true, accepting: false, codeKind: 'digits' });
  assertError(gas.doPost({ a: 'hello', code }), 'closed');
  assertError(gas.doPost({ a: 'hello', code: uuid(gas) }), 'closed');
  assert.equal(gas.cache.get('spm:fail:post'), null);
  assert.equal(gas.doGet({}).app, 'spm');
  gas.call('startDisaster_', '災害', '試験', 'メニュー');
  assert.equal(gas.doGet({ a: 'ping' }).accepting, true);
  gas.call('setPostCode_', uuid(gas).replace(/-/g, ''), 'メニュー');
  assert.equal(gas.doGet({ a: 'ping' }).codeKind, 'text');
  for (const value of ['受付中', 'はい', 'する', 'ＯＮ', 'ＴＲＵＥ', '１', 'Yes', ' OPEN ']) assert.equal(gas.call('accepting_', value), true);
  for (const value of ['', '停止中', 'false', 'no']) assert.equal(gas.call('accepting_', value), false);
});

test('3 helloの全角入力・30回の誤り・ロック中の通行証・解除', () => {
  const env = prepared(), { gas } = env;
  const entered = fullWidth(env.code.slice(0, 4)) + 'ー' + fullWidth(env.code.slice(4));
  assert.equal(gas.doPost({ a: 'hello', code: entered }).token, env.postToken);
  const wrong = uuid(gas);
  for (let i = 0; i < 29; i++) assertError(gas.doPost({ a: 'hello', code: wrong }), 'code');
  const locked = gas.doPost({ a: 'hello', code: wrong }); assertError(locked, 'locked'); assert.equal(locked.retryMinutes, 15);
  assertError(gas.doPost({ a: 'hello', code: env.code }), 'locked');
  assert.equal(gas.doPost(payload(env)).ok, true);
  assert.equal(gas.doPost({ a: 'resolve', token: env.postToken, url: 'https://www.google.com/maps?q=37,136' }).ok, true);
  assert.equal(rows(gas, '記録').filter(row => row['種類'] === 'ロック').length, 1);
  const salt = gas.props.getProperty(gas.context.PROP.SALT);
  assert.equal(gas.call('unlock_', 'メニュー').ok, true);
  assert.equal(gas.props.getProperty(gas.context.PROP.SALT), salt);
  assert.equal(gas.doPost({ a: 'hello', code: env.code }).ok, true);
  assert.equal(gas.cache.get('spm:fail:post'), null); assert.equal(gas.cache.get('spm:lock:post'), null);
  // 10分の窓が過ぎれば、失敗回数を最初から数える。
  gas.doPost({ a: 'hello', code: wrong }); gas.control.now += 600001;
  gas.doPost({ a: 'hello', code: wrong });
  assert.equal(JSON.parse(gas.cache.get('spm:fail:post')).count, 1);
});

test('4 uploadは写真・サムネ・連番・集計を保存し、同じまとまりは同じ受付番号', () => {
  const env = prepared(), { gas } = env, first = payload(env, { of: 2 });
  const a = gas.doPost(first), b = gas.doPost(payload(env, { pid: first.pid, n: 2, of: 2 })), c = gas.doPost(payload(env));
  assert.equal(a.ok, true); assert.equal(a.dup, false); assert.equal(a.no, 1); assert.equal(b.no, a.no); assert.equal(c.no, 2);
  const saved = rows(gas, '投稿_' + env.d), ds = rows(gas, '災害一覧')[0];
  assert.equal(saved.length, 3); assert.equal(rows(gas, 'サムネ_' + env.d).length, 3);
  assert.equal(ds['最後の受付番号'], 2); assert.equal(ds['投稿数'], 2); assert.equal(ds['写真枚数'], 3);
  assert.ok(saved[0]['更新番号'] < saved[1]['更新番号']); assert.ok(saved[1]['更新番号'] < saved[2]['更新番号']);
  assert.equal(Number(gas.props.getProperty(gas.context.PROP.REV)), saved[2]['更新番号']);
  assert.equal(saved[0]['緯度'], 37.041235); assert.equal(saved[0]['経度'], 136.779012); assert.equal(saved[0]['位置の取り方'], '現在地(GPS)');
  assert.equal(saved[0]['状況'], '未確認'); assert.equal(saved[0]['非表示'], false); assert.equal(saved[0]['端末'], 'iPhone');
  assert.equal(gas.sheets.get('サムネ_' + env.d).isSheetHidden(), true);
  const file = liveFiles(gas)[0];
  assert.equal(file.createdUnderLock, false); assert.equal(file.getName(), 'No0001-1_20270701-1432_冠水・浸水_山田.jpg');
  assert.equal(file.folderId, ds['写真フォルダID']); assert.equal(file.getBlob().getContentType(), 'image/jpeg');
  assert.deepEqual(file.getBlob().getBytes().slice(0, 2), [-1, -40]);
  assert.match(saved[0]['写真のURL'], /^https:\/\/drive\.google\.com\/file\/d\//);
  assert.ok(file.getName().length <= 80);
  const reads = gas.counters.propReads;
  assert.equal(gas.doPost(payload(env)).ok, true); assert.ok(gas.counters.propReads - reads <= 1);
});

test('5 重複は行もファイルも増やさず、競合とロック待ち失敗では仮写真をごみ箱へ', () => {
  const env = prepared(), { gas } = env, data = payload(env);
  const first = gas.doPost(data), again = gas.doPost(data);
  assert.equal(again.dup, true); assert.equal(again.no, first.no);
  assert.equal(liveFiles(gas).length, 1); assert.equal(rows(gas, '投稿_' + env.d).length, 1);
  gas.cache.remove('spm:id:' + data.id);
  assert.equal(gas.doPost(data).dup, true); assert.equal(liveFiles(gas).length, 1);
  const racing = payload(env);
  gas.control.onWaitLock = () => { assert.equal(gas.doPost(racing).dup, false); };
  assert.equal(gas.doPost(racing).dup, true);
  assert.equal(rows(gas, '投稿_' + env.d).length, 2); assert.equal(rows(gas, 'サムネ_' + env.d).length, 2);
  assert.equal(liveFiles(gas).length, 2); assert.equal([...gas.drive.files.values()].filter(file => file.isTrashed()).length, 1);
  const failing = payload(env); gas.control.lockAvailable = false;
  assertError(gas.doPost(failing), 'busy');
  assert.equal(liveFiles(gas).length, 2); assert.equal([...gas.drive.files.values()].filter(file => file.isTrashed()).length, 2);
  gas.control.lockAvailable = true;
  assert.equal(gas.doPost(failing).ok, true);
  gas.control.onCreateFile = () => { gas.control.onCreateFile = null; assert.equal(gas.call('stopAccepting_', false, 'メニュー').ok, true); };
  assertError(gas.doPost(payload(env)), 'closed');
  assert.equal(liveFiles(gas).length, 3); assert.equal(rows(gas, '投稿_' + env.d).length, 3);
});

test('6 uploadの入力検査・区分の補正・数式の防止・制御文字の除去', () => {
  const env = prepared(), { gas } = env;
  const badInputs = [
    { lat: 91 }, { lng: -181 }, { lat: '37' }, { lat: null }, { acc: -1 }, { acc: '1' },
    { src: 'admin' }, { src: 'none', lat: 0, lng: 0 }, { id: '写真' }, { pid: 'まとまり' },
    { n: 0 }, { n: 2, of: 1 }, { of: 51 }, { n: 1.5 }, { urgent: 'true' },
    { img: Buffer.from('JPEGではありません').toString('base64') },
    { img: 'x'.repeat(8000004) }, { img: 'data:image/jpeg;base64,' + jpeg }, { img: '/9g!' },
    { thumb: Buffer.from('JPEGではありません').toString('base64') }, { thumb: jpeg + 'A'.repeat(60000) },
    { thumb: Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(37498)]).toString('base64') }
  ];
  for (const invalid of badInputs) assertError(gas.doPost(payload(env, invalid)), 'bad');
  assert.equal(liveFiles(gas).length, 0);
  const data = payload(env, { cat: '一覧にない区分', note: '=HYPERLINK("x")', who: '名'.repeat(60), org: '団\u0000\r\n員', shot: '時'.repeat(60) });
  assert.equal(gas.doPost(data).ok, true);
  const saved = rows(gas, '投稿_' + env.d)[0], sheet = gas.sheets.get('投稿_' + env.d);
  assert.equal(saved['区分'], 'その他'); assert.equal(saved['コメント'], '=HYPERLINK("x")');
  assert.equal(saved['投稿者'].length, 40); assert.equal(saved['所属'], '団\n員'); assert.equal(saved['撮影日時'].length, 40);
  assert.ok(sheet.writes.some(write => write.input === "'=HYPERLINK(\"x\")")); assert.equal(sheet.formulas.size, 0);
  assert.equal(gas.doPost(payload(env, { note: '文'.repeat(600) })).ok, true);
  assert.equal(rows(gas, '投稿_' + env.d)[1]['コメント'].length, 500);
  const malformed = JSON.parse(gas.context.doPost({ postData: { contents: '{' } }).getContent()); assertError(malformed, 'bad');
  assertError(gas.doPost({ a: '不明' }), 'bad');
});

test('7 10分・災害の上限を超えるとlimitになり、同じ区切りの記録は1回', () => {
  const env = prepared(), { gas } = env;
  changeSetting(gas, '10分あたりの受付上限（枚）', 1);
  assert.equal(gas.doPost(payload(env)).ok, true);
  for (let i = 0; i < 3; i++) assertError(gas.doPost(payload(env)), 'limit');
  assert.equal(rows(gas, '記録').filter(row => row['種類'] === '上限').length, 1); assert.equal(liveFiles(gas).length, 1);
  gas.control.now += 600001;
  assert.equal(gas.doPost(payload(env)).ok, true);
  changeSetting(gas, '10分あたりの受付上限（枚）', 300);
  changeSetting(gas, '1つの災害の受付上限（枚）', 2);
  assertError(gas.doPost(payload(env)), 'limit'); assertError(gas.doPost(payload(env)), 'limit');
  assert.equal(rows(gas, '記録').filter(row => row['種類'] === '上限').length, 2);
  // 保存の外側で上限未満でも、待っている間の別投稿で上限に達したら受け付けない。
  const other = prepared(); changeSetting(other.gas, '10分あたりの受付上限（枚）', 1);
  other.gas.control.onWaitLock = () => { assert.equal(other.gas.doPost(payload(other)).ok, true); };
  assertError(other.gas.doPost(payload(other)), 'limit'); assert.equal(liveFiles(other.gas).length, 1);
});

test('8 loginのパスワード・独立した管理ロック・東京の日付で今日と昨日の通行証', () => {
  const env = prepared({ now: '2026-11-26T14:59:00Z' }), { gas } = env;
  assertError(gas.doPost({ a: 'login', pass: uuid(gas) }), 'auth');
  assert.equal(gas.doPost({ a: 'login', pass: '　' + fullWidth(env.pass) + '　' }).ok, true);
  const changedCase = env.pass.split('').map(c => /[a-z]/.test(c) ? c.toUpperCase() : /[A-Z]/.test(c) ? c.toLowerCase() : c).join('');
  assertError(gas.doPost({ a: 'login', pass: changedCase }), 'auth');
  for (let i = 2; i < 30; i++) gas.doPost({ a: 'login', pass: uuid(gas) });
  assertError(loginAgain(env), 'locked');
  assert.equal(gas.doPost({ a: 'hello', code: env.code }).ok, true);
  assert.equal(list(env).ok, true); // 管理ロックも、発行済みの通行証を止めない。
  gas.call('unlock_', 'メニュー'); assert.equal(loginAgain(env).ok, true);
  assert.equal(list(env).ok, true);
  gas.control.now += 120000; assert.equal(list(env).ok, true); // 東京では翌日。
  gas.control.now += 86400000; assertError(list(env), 'auth');
});

test('9 listの初回・差分・変化なしでシートもプロパティも読まない', () => {
  const env = prepared(), { gas } = env, first = payload(env), second = payload(env);
  gas.doPost(first); gas.doPost(second);
  const full = list(env); assert.equal(full.items.length, 2); assert.equal(Object.keys(full.thumbs).length, 2);
  assert.equal(full.thumbs[first.id], jpeg); assert.equal(full.disaster.id, env.d); assert.match(full.serverTime, /^\d{4}\/\d{2}\/\d{2} /);
  const before = { ...gas.counters }, same = list(env, env.d, full.rev);
  assert.deepEqual(same.items, []); assert.deepEqual(same.thumbs, {});
  assert.equal(gas.counters.sheetReads, before.sheetReads); assert.equal(gas.counters.propReads, before.propReads);
  const edited = update(env, first.pid, { status: '対応中', memo: '現地へ移動' }); assert.equal(edited.ok, true);
  const diff = list(env, env.d, full.rev); assert.equal(diff.items.length, 1); assert.equal(diff.items[0].id, first.id); assert.equal(diff.items[0].status, '対応中');
  assert.deepEqual(Object.keys(diff.thumbs), [first.id]);
  assertError(list(env, '存在しない災害', full.rev), 'notfound');
  assertError(list(env, env.d, -1), 'bad');
  gas.cache.remove('spm:rev'); assert.equal(list(env, env.d, diff.rev).ok, true);
});

test('10 updateはpidの全写真・過去の災害も変更し、許可しない項目は無視する', () => {
  const env = prepared(), { gas } = env, data = payload(env, { of: 2 });
  gas.doPost(data); gas.doPost(payload(env, { pid: data.pid, n: 2, of: 2 }));
  const other = payload(env); gas.doPost(other);
  const changed = update(env, data.pid, { status: '確認済', memo: '確'.repeat(1200), cat: 'その他', urgent: true, hidden: true, no: 900, fileId: '変更禁止', who: '変更禁止' });
  assert.equal(changed.items.length, 2);
  for (const item of changed.items) {
    assert.equal(item.status, '確認済'); assert.equal(item.memo.length, 1000); assert.equal(item.cat, 'その他'); assert.equal(item.urgent, true); assert.equal(item.hidden, true);
    assert.equal(item.no, 1); assert.equal(item.who, data.who); assert.notEqual(item.fileId, '変更禁止'); assert.equal(item.rev, changed.rev);
  }
  assert.equal(list(env).items.find(item => item.pid === other.pid).status, '未確認');
  assertError(update(env, data.pid, { status: '未定義の状況' }), 'bad');
  assertError(update(env, data.pid, { cat: '未定義の区分' }), 'bad');
  assertError(update(env, data.pid, { lat: 37 }), 'bad'); assertError(update(env, data.pid, { hidden: 'true' }), 'bad');
  assertError(update(env, uuid(gas), { status: '対応済' }), 'notfound');
  assert.equal(config(env, { op: 'start', kind: '訓練', name: '次の訓練' }).ok, true);
  assert.equal(update(env, data.pid, { status: '対応済' }, env.d).items.length, 2);
  assert.equal(list(env).items.filter(item => item.pid === data.pid).every(item => item.status === '対応済'), true);
});

test('11 configの受付停止・再開・合言葉・開始・名前・初期位置・URL・変更禁止', () => {
  const env = prepared(), { gas } = env, oldToken = env.postToken;
  const stopped = config(env, { op: 'stop', changeCode: true }); assert.equal(stopped.ok, true); assert.notEqual(stopped.newCode, env.code);
  assert.equal(gas.cache.get('spm:cfg'), null); assert.equal(stopped.settings.accepting, false);
  assertError(gas.doPost(payload(env)), 'closed');
  assert.equal(config(env, { op: 'resume' }).ok, true); assertError(gas.doPost(payload(env)), 'code');
  assertError(gas.doPost({ a: 'resolve', token: oldToken, url: 'https://google.com/maps?q=37,136' }), 'code');
  for (const code of ['', 'a'.repeat(33), '<不正>']) assertError(config(env, { op: 'code', code }), 'bad');
  const manual = uuid(gas).replace(/-/g, '').slice(0, 16), formatted = fullWidth(manual.slice(0, 8)) + '-' + fullWidth(manual.slice(8));
  const changed = config(env, { op: 'code', code: formatted }); assert.equal(changed.newCode, manual);
  assert.equal(gas.doPost({ a: 'hello', code: formatted }).ok, true);
  const auto = config(env, { op: 'code' }); assert.match(auto.newCode, /^\d{8}$/); assert.notEqual(auto.newCode, manual);
  const oldHello = gas.doPost({ a: 'hello', code: auto.newCode });
  const started = config(env, { op: 'start', kind: '訓練', name: '次の訓練' }); assert.equal(started.ok, true); assert.notEqual(started.newCode, auto.newCode);
  const nextId = started.settings.current.id; assert.notEqual(nextId, env.d);
  const ds = rows(gas, '災害一覧'); assert.equal(ds[0]['状態'], '終了'); assert.ok(ds[0]['終了日時']); assert.equal(ds[1]['種別'], '訓練');
  assert.ok(gas.sheets.has('投稿_' + nextId)); assert.ok(gas.sheets.has('サムネ_' + nextId));
  assert.ok([...gas.drive.folders.values()].some(folder => folder.getName() === nextId + '_訓練_次の訓練'));
  assertError(gas.doPost(payload(env, { token: oldHello.token })), 'code');
  const newHello = gas.doPost({ a: 'hello', code: started.newCode });
  assert.equal(gas.doPost(payload(env, { token: newHello.token })).ok, true); assert.equal(rows(gas, '投稿_' + nextId).length, 1); assert.equal(rows(gas, '投稿_' + env.d).length, 0);
  assert.equal(config(env, { op: 'rename', d: nextId, name: '=訓練名' }).settings.current.name, '=訓練名');
  assert.equal(config(env, { op: 'mapHome', lat: 37.1, lng: 136.2, zoom: 14 }).settings.map.zoom, 14);
  assert.deepEqual(loginAgain(env).settings.map, { lat: 37.1, lng: 136.2, zoom: 14 });
  assertError(config(env, { op: 'mapHome', lat: 91, lng: 136, zoom: 14 }), 'bad');
  assertError(config(env, { op: 'mapHome', lat: 37, lng: 136, zoom: 19 }), 'bad');
  const url = 'https://example.invalid/index.html';
  assert.equal(config(env, { op: 'postPageUrl', url }).settings.postPageUrl, url);
  assertError(config(env, { op: 'postPageUrl', url: 'javascript:alert(1)' }), 'bad');
  const before = gas.props.getProperty(gas.context.PROP.ADMIN_PASS);
  assertError(config(env, { op: 'adminPass', pass: uuid(gas) }), 'bad'); assert.equal(gas.props.getProperty(gas.context.PROP.ADMIN_PASS), before);
  const until = gas.control.now + 900000;
  for (const kind of ['post', 'admin']) { gas.cache.put('spm:lock:' + kind, String(until), 900); gas.cache.put('spm:fail:' + kind, JSON.stringify({ count: 30, first: gas.control.now }), 600); }
  assert.equal(config(env, { op: 'unlock' }).ok, true);
  assert.equal(gas.cache.get('spm:lock:post'), null); assert.equal(gas.cache.get('spm:fail:post'), null);
  assert.equal(gas.cache.get('spm:lock:admin'), String(until)); assert.ok(gas.cache.get('spm:fail:admin'));
  gas.call('unlock_', 'メニュー');
  assertError(config(env, { op: 'start', kind: '災害', name: ' ' }), 'bad');
  assertError(config(env, { op: 'start', kind: '別', name: '試験' }), 'bad');
  const fresh = createGas(); fresh.call('setup_'); assertError(fresh.call('resumeAccepting_', 'メニュー'), 'bad');
});

test('12 災害のlistは混ざらず、過去の災害のphotoも取得できる', () => {
  const env = prepared(), { gas } = env, old = payload(env); gas.doPost(old);
  const start = config(env, { op: 'start', kind: '災害', name: '別の災害' }), next = start.settings.current.id;
  const token = gas.doPost({ a: 'hello', code: start.newCode }).token, newer = payload(env, { token }); gas.doPost(newer);
  assert.deepEqual(list(env).items.map(item => item.id), [old.id]); assert.deepEqual(list(env, next).items.map(item => item.id), [newer.id]);
  const photo = gas.doPost({ a: 'photo', token: env.adminToken, d: env.d, id: old.id });
  assert.equal(photo.ok, true); assert.equal(photo.mime, 'image/jpeg'); assert.equal(photo.b64, jpeg); assert.match(photo.name, /^No0001-/);
  assertError(gas.doPost({ a: 'photo', token: env.adminToken, d: next, id: old.id }), 'notfound');
  assertError(gas.doPost({ a: 'photo', token: uuid(gas), d: env.d, id: old.id }), 'auth');
  assertError(gas.doPost({ a: 'photo', token: env.adminToken, d: env.d, id: uuid(gas) }), 'notfound');
});

test('13 resolveは転送の各ホストを検査し、Googleマップの各形式を読む', () => {
  const env = prepared({ urlRoutes: [
    { url: 'https://maps.app.goo.gl/first', response: { status: 302, headers: { Location: 'https://goo.gl/maps/second' } } },
    { url: 'https://goo.gl/maps/second', response: { status: 302, headers: { location: 'https://www.google.com/maps/place/x/!3d37.0412!4d136.7790' } } },
    { url: 'https://maps.app.goo.gl/unsafe', response: { status: 302, headers: { Location: 'https://example.invalid/?q=37,136' } } },
    { url: /^https:\/\/maps\.app\.goo\.gl\/loop/, response: { status: 302, headers: { Location: 'https://maps.app.goo.gl/loop' } } }
  ] });
  const { gas } = env, resolve = url => gas.doPost({ a: 'resolve', token: env.postToken, url });
  assert.deepEqual(resolve('https://maps.app.goo.gl/first'), { ok: true, lat: 37.0412, lng: 136.779 });
  assert.equal(gas.requests.length, 2); assert.ok(gas.requests.every(request => request.followRedirects === false && request.muteHttpExceptions === true));
  for (const url of ['https://example.invalid/?q=37,136', 'https://google.com.example.invalid/maps', 'https://google.com@127.0.0.1/maps', 'http://google.com/maps?q=37,136', 'https://google.com:443/maps?q=37,136']) assertError(resolve(url), 'bad');
  assertError(resolve('https://maps.app.goo.gl/unsafe'), 'bad');
  assertError(resolve('https://google.com/maps/place/役場'), 'notfound');
  const before = gas.requests.length; assertError(resolve('https://maps.app.goo.gl/loop'), 'notfound'); assert.equal(gas.requests.length - before, 4);
  const forms = [
    'https://google.com/maps/!3d37.0412!4d136.7790/@1,2', 'https://google.com/maps/@37.0412,136.7790,15z',
    'https://google.com/maps?q=37.0412%2C136.7790', 'https://google.com/maps?api=1&query=37.0412,+136.7790',
    'https://google.com/maps?ll=37.0412,136.7790', 'https://google.com/maps?center=37.0412,136.7790',
    'https://google.com/maps?destination=37.0412,136.7790', 'https://google.com/maps/search/37.0412,+136.7790',
    'https://google.com/maps/place/37.0412,136.7790'
  ];
  for (const url of forms) assert.deepEqual(resolve(url), { ok: true, lat: 37.0412, lng: 136.779 });
  for (const text of ['３７．０４１２，１３６．７７９０', '37.0412 136.7790', '北緯37.0412 東経136.7790', 'N37.0412 E136.7790']) assert.deepEqual(gas.call('parseLocationText_', text), { lat: 37.0412, lng: 136.779, kind: 'coords' });
  const dms = gas.call('parseLocationText_', '37°02\'28.4"S 136°46\'44.4"W');
  assert.ok(dms.lat < 0 && dms.lng < 0); assert.equal(gas.call('parseLocationText_', '91,136'), null);
  assert.equal(gas.call('parseLocationText_', '37°99\'00"N 136°46\'00"E'), null);
});

test('14 メニューの7項目・共通処理を呼ぶダイアログ・HTMLの特殊文字', () => {
  const gas = createGas(); gas.call('onOpen');
  assert.equal(gas.ui.menus.length, 1); assert.equal(gas.ui.menus[0].name, '災害写真マップ'); assert.equal(gas.ui.menus[0].items.length, 7);
  const labels = ['①最初の設定', '②受付を始める', '③受付を止める', '④投稿の合言葉を変える', '⑤管理画面のパスワードを変える', '⑥いまの設定を見る', '⑦ロックを解除'];
  assert.deepEqual(gas.ui.menus[0].items.map(item => item.label), labels);
  gas.call('menuSetup'); assert.match(gas.ui.dialogs.slice(-1)[0].html, /id="home"/);
  assert.equal(gas.call('dlgSetupHome', '37.0412,136.7790').ok, true);
  gas.call('menuSetup'); assert.match(gas.ui.dialogs.slice(-1)[0].html, /設定済みです/); assert.doesNotMatch(gas.ui.dialogs.slice(-1)[0].html, /id="home"/);
  assert.equal(gas.call('dlgStart', '訓練', '対話の訓練').ok, true);
  assert.equal(gas.call('dlgStop', true).ok, true); assert.equal(gas.doGet({ a: 'ping' }).accepting, false);
  assert.equal(gas.call('dlgResume').ok, true); assert.equal(gas.doGet({ a: 'ping' }).accepting, true);
  const generatedCode = gas.call('dlgCode', null); assert.match(generatedCode.newCode, /^\d{8}$/);
  const previousToken = gas.doPost({ a: 'login', pass: gas.props.getProperty(gas.context.PROP.ADMIN_PASS) }).token;
  assert.equal(gas.call('dlgAdminPass', null).ok, true);
  const currentId = gas.props.getProperty(gas.context.PROP.CURRENT);
  assertError(gas.doPost({ a: 'list', token: previousToken, d: currentId, since: 0 }), 'auth');
  assert.equal(gas.call('dlgUnlock').ok, true);
  // 手でプロパティを編集した場合も、ダイアログのHTMLを壊さない。
  gas.props.setProperty(gas.context.PROP.POST_CODE, '<b>&"\''); gas.cache.remove('spm:cfg'); gas.call('menuCurrent');
  const html = gas.ui.dialogs.slice(-1)[0].html;
  assert.match(html, /&lt;b&gt;&amp;&quot;&#39;/); assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i);
  for (const name of ['menuStart', 'menuStop', 'menuCode', 'menuAdminPass', 'menuUnlock']) gas.call(name);
  assert.ok(gas.ui.dialogs.every(dialog => dialog.width >= 500 && dialog.height >= 600));
});

test('15 応答と記録に秘密を漏らさず、例外の内容もそのまま返さない', () => {
  const env = prepared(), { gas } = env, data = payload(env); gas.doPost(data);
  const responses = [gas.doGet({ a: 'ping' }), gas.doGet({}), gas.doPost({ a: 'hello', code: env.code }), gas.doPost(data), list(env), update(env, data.pid, { status: '確認済' }), gas.doPost({ a: 'photo', token: env.adminToken, d: env.d, id: data.id }), gas.doPost({ a: 'resolve', token: env.postToken, url: 'https://google.com/maps?q=37,136' })];
  const login = loginAgain(env); assert.equal(login.settings.postCode, env.code); delete login.settings.postCode; responses.push(login);
  // stateも管理専用のsettings.postCodeだけを返す。それ以外に秘密を含めない。
  const snapshot = gas.doPost({ a: 'state', token: env.adminToken }); assert.equal(snapshot.settings.postCode, env.code); delete snapshot.settings.postCode; responses.push(snapshot);
  const change = config(env, { op: 'code' }), newCode = change.newCode; delete change.newCode; responses.push(change);
  const p = gas.props.getProperties(), secrets = [env.code, env.pass, newCode, p[gas.context.PROP.SALT]];
  for (const response of responses) for (const secret of secrets) assert.equal(JSON.stringify(response).includes(secret), false);
  const logText = JSON.stringify(rows(gas, '記録'));
  for (const secret of secrets) assert.equal(logText.includes(secret), false);
  // ドライブ例外に認証情報が含まれていても、固定文のserverと記録だけになる。
  const newest = gas.doPost({ a: 'hello', code: newCode }).token;
  gas.control.onCreateFile = () => { throw new Error(env.pass); };
  const failed = gas.doPost(payload(env, { token: newest })); assertError(failed, 'server');
  assert.equal(JSON.stringify(failed).includes(env.pass), false); assert.equal(JSON.stringify(rows(gas, '記録')).includes(env.pass), false);
  assert.equal(JSON.stringify(gas.logs).includes(env.pass), false);
});

test('16 共通fixtureの正規化と、末尾が欠けたコードのcodeComplete', () => {
  const gas = createGas();
  for (const example of codeCases) assert.equal(gas.call('normCode_', example.input), example.expected, JSON.stringify(example.input));
  assert.equal(gas.call('codeComplete_'), true);
  const source = fs.readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8').replace(/^var SPM_CODE_END = .*;\s*$/m, '');
  const cut = createGas({ source }); cut.call('setup_');
  assert.equal(cut.call('codeComplete_'), false); assert.equal(cut.doGet({ a: 'ping' }).codeComplete, false);
  const login = cut.doPost({ a: 'login', pass: cut.props.getProperty(cut.context.PROP.ADMIN_PASS) });
  assert.equal(login.codeComplete, false); assert.equal(login.settings.codeComplete, false);
  assert.equal(gas.call('formatCode_', null), '');
  const env = prepared(), displayed = gas.call('formatCode_', env.code);
  assert.equal(displayed, env.code.slice(0, 4) + '-' + env.code.slice(4)); assert.match(gas.call('readCode_', env.code), /、/);
});

test('17 位置なしを受け付け、初めての修正で元の座標を保存する', () => {
  const env = prepared(), { gas } = env, none = payload(env, { src: 'none', lat: null, lng: null, acc: null });
  assert.equal(gas.doPost(none).ok, true);
  const before = rows(gas, '投稿_' + env.d)[0]; assert.equal(before['緯度'], ''); assert.equal(before['経度'], ''); assert.equal(before['位置の取り方'], '位置なし');
  const placed = update(env, none.pid, { lat: 37.2, lng: 136.3 }).items[0];
  assert.equal(placed.src, 'admin'); assert.equal(placed.origLat, ''); assert.equal(placed.origLng, '');
  assert.equal(rows(gas, '投稿_' + env.d)[0]['位置の取り方'], '管理者が修正');
  const moved = update(env, none.pid, { lat: 37.4, lng: 136.5 }).items[0]; assert.equal(moved.origLat, ''); assert.equal(moved.origLng, '');
  const gps = payload(env); gas.doPost(gps);
  const corrected = update(env, gps.pid, { lat: 38, lng: 137 }).items[0]; assert.equal(corrected.origLat, 37.041235); assert.equal(corrected.origLng, 136.779012);
  const twice = update(env, gps.pid, { lat: 39, lng: 138 }).items[0]; assert.equal(twice.origLat, corrected.origLat); assert.equal(twice.origLng, corrected.origLng);
});

test('18 数字や日付に見える文字を保護し、列の並べ替えと見出しの補充に対応', () => {
  const env = prepared(), { gas } = env, sheet = gas.sheets.get('投稿_' + env.d);
  const heads = sheet.data[0], idIndex = heads.indexOf('写真ID'), noteIndex = heads.indexOf('コメント');
  [heads[idIndex], heads[noteIndex]] = [heads[noteIndex], heads[idIndex]];
  const data = payload(env, { note: '2027/07/01', who: '0123', org: '1-2' }); assert.equal(gas.doPost(data).ok, true);
  assert.equal(gas.doPost(data).dup, true);
  const item = rows(gas, '投稿_' + env.d)[0];
  assert.equal(item['コメント'], '2027/07/01'); assert.equal(item['投稿者'], '0123'); assert.equal(item['所属'], '1-2');
  for (const value of ['2027/07/01', '0123', '1-2']) assert.ok(sheet.writes.some(write => write.input === "'" + value && typeof write.value === 'string'));
  assert.equal(typeof item['受付日時'], 'string'); assert.ok(sheet.writes.some(write => write.input === "'" + item['受付日時']));
  assert.equal(sheet.formulas.size, 0);
  assert.equal(list(env).items[0].note, '2027/07/01');
  assert.equal(update(env, data.pid, { memo: '1-2' }).items[0].memo, '1-2');
  const removed = sheet.data[0].indexOf('元の経度'); sheet.data.forEach(row => row.splice(removed, 1));
  assert.equal(gas.call('setup_').ok, true); assert.equal(sheet.data[0].slice(-1)[0], '元の経度');
  assert.equal(rows(gas, '投稿_' + env.d)[0]['写真ID'], data.id);
  // mock自体も引用符なしの数値・数式を区別して保持する。
  const probe = gas.context.SpreadsheetApp.getActiveSpreadsheet().insertSheet('偽物の確認');
  probe.appendRow(['0123', '=1+1', "'0123", "'=1+1", '2027/07/01', "'2027/07/01"]);
  assert.equal(probe.data[0][0], 123); assert.equal(probe.formulas.get('1:2'), '=1+1'); assert.equal(probe.data[0][2], '0123'); assert.equal(probe.formulas.has('1:4'), false);
  assert.ok(probe.data[0][4] instanceof Date); assert.equal(probe.data[0][5], '2027/07/01');
});

test('19 stateは管理の通行証で外部の受付・合言葉・災害一覧の変更を取り直す', () => {
  const env = prepared(), { gas } = env;
  const state = token => gas.doPost({ a: 'state', token });
  assertError(state(), 'auth'); assertError(state(env.postToken), 'auth');
  const first = state(env.adminToken);
  assert.equal(first.ok, true); assert.equal(first.version, gas.context.APP_VERSION);
  assert.equal(first.settings.postCode, env.code); assert.equal(first.settings.accepting, true);
  assert.equal(first.settings.current.id, env.d); assert.equal(first.disasters.length, 1);
  assert.equal(first.token, undefined);
  assert.equal(JSON.stringify(first).includes(env.pass), false);
  gas.call('stopAccepting_', true, 'メニュー');
  const stopped = state(env.adminToken);
  assert.equal(stopped.settings.accepting, false); assert.equal(stopped.disasters[0].state, '停止中');
  assert.notEqual(stopped.settings.postCode, env.code);
  gas.call('startDisaster_', '訓練', '外で始めた訓練', 'メニュー');
  const next = state(env.adminToken);
  assert.equal(next.settings.accepting, true); assert.equal(next.disasters.length, 2);
  assert.notEqual(next.settings.current.id, env.d); assert.equal(next.settings.current.name, '外で始めた訓練');
  assert.equal(next.disasters.find(d => d.id === env.d).state, '終了');
  gas.control.now += 2 * 86400000;
  assertError(state(env.adminToken), 'auth');
});
