(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var database, running = false, sending = false, initialized = false, options = {}, owner, activeSend;
  var reasons = { network: '電波が届きません', timeout: 'サーバーの返事を確認できません', server: 'サーバーの返事を確認できません', busy: '混雑しています', closed: '受付停止中', code: '合言葉が変わりました', limit: '混み合っています', bad: '入力を確認してください' };
  function open() {
    if (database) return database;
    database = new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('この端末では写真を保存できません。Safari／Chromeで開き直してください。')); return; }
      var request = root.indexedDB.open('spm', 1);
      request.onupgradeneeded = function () {
        ['draft', 'outbox', 'history'].forEach(function (name) { if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' }); });
      };
      request.onsuccess = function () { var db = request.result; db.onversionchange = function () { db.close(); database = null; }; resolve(db); };
      request.onerror = function () { database = null; reject(new Error('写真を保存できません。空き容量とブラウザの設定を確認してください。')); };
      request.onblocked = function () { reject(new Error('ほかのタブを閉じて、もう一度開いてください。')); };
    });
    return database;
  }
  async function transaction(names, mode, run) {
    var db = await open();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(names, mode), result;
      tx.oncomplete = function () { resolve(result); };
      tx.onabort = tx.onerror = function () { reject(new Error('端末の空きが足りないため保存できません。空き容量を確認し、下書きは消さずにやり直してください。')); };
      try { run(tx, function (value) { result = value; }); } catch (e) { tx.abort(); reject(e); }
    });
  }
  function all(name) { return transaction([name], 'readonly', function (tx, set) { var req = tx.objectStore(name).getAll(); req.onsuccess = function () { set(req.result); }; }); }
  function put(name, record) { return transaction([name], 'readwrite', function (tx) { tx.objectStore(name).put(record); }); }
  async function remove(name, id) { await transaction([name], 'readwrite', function (tx) { tx.objectStore(name).delete(id); }); await changed(); }
  function saveDraft(record) {
    if (!(record.img instanceof ArrayBuffer) || !(record.thumb instanceof ArrayBuffer)) return Promise.reject(new Error('写真・動画を保存する形式が違います。'));
    return put('draft', record).catch(function (e) { if (record.kind === 'video') throw new Error('端末の空きが足りないため保存できません。空き容量とブラウザの設定を確認してください。'); throw e; });
  }
  async function enqueue(records) {
    // 読み取りから削除まで同じトランザクションに入れ、途中で写真を失わない。
    await transaction(['draft', 'outbox'], 'readwrite', function (tx) {
      records.forEach(function (record) {
        var req = tx.objectStore('draft').get(record.id);
        req.onsuccess = function () {
          if (!req.result) { tx.abort(); return; }
          tx.objectStore('outbox').put(Object.assign({}, req.result, record, { createdAt: req.result.createdAt || Date.now(), attempts: 0, lastReason: root.navigator.onLine === false ? reasons.network : '', state: 'waiting', updatedAt: Date.now() }));
          tx.objectStore('draft').delete(record.id);
        };
      });
    });
    await changed();
  }
  function queueRecords() {
    var auth = options.getAuth ? options.getAuth() : {};
    if (!auth.disasterId) return all('outbox');
    return transaction(['outbox'], 'readwrite', function (tx, set) {
      var store = tx.objectStore('outbox'), req = store.getAll();
      req.onsuccess = function () {
        req.result.forEach(function (record) {
          if (record.disasterId !== auth.disasterId && record.state !== 'other') {
            record.state = 'other'; record.lastReason = '前の受付の分です。「今の受付で送る」か「消す」を選んでください。'; record.lastError = ''; record.updatedAt = Date.now();
            store.put(record);
          }
        });
        set(req.result);
      };
    });
  }
  async function useCurrent(name, ids, disaster) {
    if (running) throw new Error('送信が終わってから、もう一度お試しください。');
    if (!disaster || !disaster.id) throw new Error('新しい合言葉を入れてください。');
    await transaction([name], 'readwrite', function (tx) {
      var store = tx.objectStore(name);
      ids.forEach(function (id) {
        var req = store.get(id);
        req.onsuccess = function () {
          var record = req.result; if (!record) return;
          record.disasterId = disaster.id; record.disasterName = disaster.name || '';
          delete record.videoNext;
          if (name === 'outbox') { record.state = 'waiting'; record.attempts = 0; record.lastReason = ''; record.lastError = ''; record.updatedAt = Date.now(); }
          store.put(record);
        };
      });
    });
    await changed();
  }
  async function removeMany(name, ids) {
    await transaction([name], 'readwrite', function (tx) { ids.forEach(function (id) { tx.objectStore(name).delete(id); }); });
    await changed();
  }
  async function changed() {
    var records = await queueRecords();
    root.dispatchEvent(new root.CustomEvent('spm-outbox', { detail: { count: records.length, records: records, sending: sending } }));
  }
  async function remember(record, reply) {
    await transaction(['outbox', 'history'], 'readwrite', function (tx) {
      var saved = Object.assign({}, record, { no: reply.no, sentAt: Date.now(), state: 'sent', lastReason: '', lastError: '' });
      delete saved.img; delete saved.token;
      tx.objectStore('history').put(saved); tx.objectStore('outbox').delete(record.id);
      var req = tx.objectStore('history').getAll();
      req.onsuccess = function () { req.result.sort(function (a, b) { return b.sentAt - a.sentAt; }).slice(200).forEach(function (r) { tx.objectStore('history').delete(r.id); }); };
    });
  }
  function payload(record, token) {
    var data = { token: token };
    ['id', 'pid', 'n', 'of', 'lat', 'lng', 'acc', 'src', 'shot', 'cat', 'urgent', 'note', 'who', 'org', 'ua'].forEach(function (key) { data[key] = record[key]; });
    data.img = root.SPM.photo.toBase64(record.img); data.thumb = root.SPM.photo.toBase64(record.thumb);
    return data;
  }
  function wait(ms) { return new Promise(function (resolve) { root.setTimeout(resolve, ms); }); }
  async function sendQueue() {
    var records = (await queueRecords()).sort(function (a, b) { return a.createdAt - b.createdAt || a.n - b.n; });
    var sent = [], completed = 0;
    for (var r = 0; r < records.length; r++) {
      var record = records[r];
      if (record.state === 'bad' || record.state === 'other') continue;
      if (record.state === 'sending' && Date.now() - record.updatedAt < 180000) continue;
      if (record.state === 'sending') record.state = 'waiting';
      var auth = options.getAuth ? options.getAuth() : {};
      if (!auth.token) break;
      if (record.disasterId !== auth.disasterId) {
        record.state = 'other'; record.lastReason = '前の受付の分です。「今の受付で送る」か「消す」を選んでください。'; record.lastError = ''; record.updatedAt = Date.now(); await put('outbox', record); continue;
      }
      var reply;
      for (var attempt = 0; attempt <= 3; attempt++) {
        if (attempt) await wait([2000, 5000, 10000][attempt - 1]);
        // 応答を失っても同じIDのまま送り直す。
        record.state = 'sending'; record.updatedAt = Date.now(); record.attempts++; await put('outbox', record);
        sending = true; await changed();
        if (record.kind === 'video') {
          reply = await root.SPM.video.upload(record, auth.token, function (p) {
            // 大きな動画本体を塊ごとにIndexedDBへ書き直さない。再開位置は毎回サーバーに聞く。
            record.videoNext = p.next;
            if (options.onVideoProgress) options.onVideoProgress(p);
          });
        } else reply = await root.SPM.api('upload', payload(record, auth.token));
        // 動画の送り直しはuploadの入口へ戻り、videoStartで位置を確かめる。
        var retry = record.kind === 'video' ? root.SPM.video.retryAction(reply) === 'videoStart' : !reply.ok && ['network', 'server', 'busy'].indexOf(reply.error) >= 0;
        if (!retry) break;
        if (root.navigator.onLine === false) break;
      }
      sending = false; completed++;
      if (reply.ok) { await remember(record, reply); sent.push({ id: record.id, no: reply.no }); }
      else {
        record.state = reply.error === 'bad' ? 'bad' : 'waiting'; record.updatedAt = Date.now();
        record.lastReason = reply.error === 'bad' ? reply.message : reasons[reply.error] || reply.message;
        record.lastError = reply.error; await put('outbox', record);
      }
      await changed();
      if (options.onProgress) options.onProgress({ completed: completed, total: records.length, sent: sent.length });
      if (options.onReply) options.onReply(reply);
      if (!reply.ok && ['closed', 'code', 'limit'].indexOf(reply.error) >= 0) break;
    }
    return { sent: sent, remaining: (await all('outbox')).length };
  }
  async function fallbackLock(fn) {
    var key = 'spm-sender', lease, heartbeat;
    owner = owner || root.SPM.util.uuid();
    try {
      lease = JSON.parse(root.localStorage.getItem(key) || 'null');
      if (lease && lease.until > Date.now() && lease.owner !== owner) return { sent: [], remaining: (await all('outbox')).length };
      root.localStorage.setItem(key, JSON.stringify({ owner: owner, until: Date.now() + 30000 }));
      await wait(100);
      lease = JSON.parse(root.localStorage.getItem(key) || 'null');
      if (!lease || lease.owner !== owner) return { sent: [], remaining: (await all('outbox')).length };
      heartbeat = root.setInterval(function () { root.localStorage.setItem(key, JSON.stringify({ owner: owner, until: Date.now() + 30000 })); }, 8000);
      return await fn();
    } finally {
      root.clearInterval(heartbeat);
      try { lease = JSON.parse(root.localStorage.getItem(key) || 'null'); if (lease && lease.owner === owner) root.localStorage.removeItem(key); } catch (e) { /* 使用中の印は30秒で切れる。 */ }
    }
  }
  async function runSender() {
    running = true;
    try {
      if (root.navigator.onLine === false) return { sent: [], remaining: (await all('outbox')).length };
      if (root.navigator.locks && root.navigator.locks.request) return await root.navigator.locks.request('spm-sender', { ifAvailable: true }, async function (lock) { return lock ? sendQueue() : { sent: [], remaining: (await all('outbox')).length }; });
      return await fallbackLock(sendQueue);
    } finally { running = false; sending = false; await changed(); }
  }
  function send() {
    if (activeSend) return activeSend;
    activeSend = runSender().finally(function () { activeSend = null; });
    return activeSend;
  }
  function start(config) {
    options = config || {};
    if (initialized) return;
    initialized = true;
    function trigger() { send().catch(function (e) { root.SPM.dom.toast(root.SPM.util.userMessage(e, '送信できませんでした。もう一度お試しください。')); }); }
    root.addEventListener('online', trigger);
    root.document.addEventListener('visibilitychange', function () { if (!root.document.hidden) trigger(); });
    root.setInterval(trigger, 60000);
  }
  root.SPM.outbox = { open: open, all: all, saveDraft: saveDraft, enqueue: enqueue, remove: remove, removeMany: removeMany, useCurrent: useCurrent, send: send, start: start, changed: changed, isSending: function () { return running; } };
})(typeof window !== 'undefined' ? window : globalThis);
