(function (root) {
  'use strict';
  var S = root.SPM = root.SPM || {}, entries = new Map(), queues = { photo: [], media: [] }, active = { photo: 0, media: 0 };
  var limit = 400 * 1024 * 1024, size = 0, clock = 0;
  function stoppedError() { return new Error('読み込みを終了しました。'); }
  function allowed(entry) { return !entry.dead && (entry.priority < 2 || (!root.document.hidden && S.admin.state.prefetch)); }
  function pump(type) {
    var queue = queues[type];
    queue.sort(function (a, b) { return a.entry.priority - b.entry.priority || a.order - b.order; });
    for (var i = queue.length - 1; i >= 0; i--) if (queue[i].entry.dead) queue.splice(i, 1)[0].reject(stoppedError());
    while (active[type] < (type === 'photo' ? 2 : 4)) {
      var index = queue.findIndex(function (job) { return allowed(job.entry); });
      if (index < 0) break;
      var job = queue.splice(index, 1)[0]; active[type]++;
      (function (current) {
        Promise.resolve().then(function () { if (current.entry.dead) throw stoppedError(); return current.task(); }).then(current.resolve, current.reject).finally(function () { active[type]--; pump(type); });
      })(job);
    }
  }
  function resume() { pump('photo'); pump('media'); }
  function run(type, entry, task) {
    return new Promise(function (resolve, reject) { queues[type].push({ entry: entry, task: task, resolve: resolve, reject: reject, order: ++clock }); pump(type); });
  }
  function drop(entry) {
    entry.dead = true; entry.listeners.clear();
    if (entry.url) { root.URL.revokeObjectURL(entry.url); size -= entry.blob.size; }
    entries.delete(entry.key);
  }
  function trim() {
    Array.from(entries.values()).filter(function (e) { return e.blob && !e.pins; }).sort(function (a, b) { return a.used - b.used; }).some(function (e) {
      if (size <= limit) return true;
      drop(e); return false;
    });
  }
  function clear() { entries.forEach(drop); resume(); }
  function prune(d, ids) { entries.forEach(function (e) { if (e.d === d && !ids.has(e.id)) drop(e); }); resume(); }
  function progress(entry, value) { entry.progress = value; entry.listeners.forEach(function (listener) { listener(value); }); }
  async function fetchEntry(entry) {
    var blob;
    if (entry.kind !== 'video') {
      var reply = await run('photo', entry, function () { return S.admin.request('photo', { d: entry.d, id: entry.id }); });
      if (entry.dead) throw stoppedError();
      if (!reply.ok && reply.error === 'video') entry.kind = 'video';
      else {
        if (!reply.ok) throw new Error(reply.message || '写真を読み込めませんでした。');
        blob = new Blob([S.share.mediaBytes(reply.b64)], { type: reply.mime });
      }
    }
    if (entry.kind === 'video') blob = await S.share.fetchMedia(entry.d, entry.id, function (value) { progress(entry, value); }, function () { return entry.dead; }, entry);
    if (entry.dead || !blob) throw stoppedError();
    entry.blob = blob; entry.mime = blob.type; entry.url = root.URL.createObjectURL(blob); entry.used = ++clock; size += blob.size;
    trim(); return entry;
  }
  // acquireの持ち主は表示が終わったらreleaseする。URLの破棄はこの仕組みだけが行う。
  function acquire(d, photo, priority, listener) {
    var key = d + ':' + photo.id, entry = entries.get(key);
    if (!entry) {
      entry = { key: key, d: d, id: photo.id, kind: photo.kind || 'photo', priority: priority || 0, pins: 0, used: ++clock, listeners: new Set(), consumers: new Set(), dead: false };
      entries.set(key, entry);
    }
    var consumer = { priority: priority || 0 };
    entry.consumers.add(consumer);
    entry.priority = Array.from(entry.consumers).reduce(function (value, c) { return Math.min(value, c.priority); }, 3);
    entry.used = ++clock; entry.pins++;
    if (listener) { entry.listeners.add(listener); if (entry.progress) listener(entry.progress); }
    if (!entry.promise) entry.promise = fetchEntry(entry).catch(function (error) { if (entries.get(key) === entry) drop(entry); throw error; });
    resume();
    var released = false;
    return { promise: entry.promise, release: function () {
      if (released) return;
      released = true; entry.pins--; entry.consumers.delete(consumer);
      // 閉じた詳細の残りは同じ投稿の先読みとして続け、次に開いたものを先にする。
      entry.priority = entry.consumers.size ? Array.from(entry.consumers).reduce(function (value, c) { return Math.min(value, c.priority); }, 3) : 1;
      if (listener) entry.listeners.delete(listener); trim(); resume();
    } };
  }
  function get(d, photo, priority) { var handle = acquire(d, photo, priority); return handle.promise.finally(handle.release); }
  // state.photosの従来の参照先も、URLを確実に破棄するこの窓口へ集約する。
  S.mediaCache = { acquire: acquire, get: get, run: run, resume: resume, clear: clear, prune: prune, has: function (key) { return entries.has(key); } };
})(typeof window !== 'undefined' ? window : globalThis);
