(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var S = root.SPM, dom = S.dom, el = dom.el, document = root.document;
  var state = {
    token: '', settings: {}, disasters: [], version: '', d: '', caches: new Map(), photos: S.mediaCache,
    view: 'map', summaryOpen: { map: true, tiles: true, list: false }, selected: new Set(), unread: new Set(), opened: new Set(),
    filters: { categories: [], statuses: [], urgent: false, from: '', to: '', person: '', keyword: '', hidden: false },
    sort: { key: 'no', direction: -1 }, sound: false, prefetch: stored(storageFor('localStorage'), 'spm-prefetch') !== 'off', epoch: 0
  };
  var timer, stateTimer, stateLoading = null, store, loading = new Map(), configuring = false, audio;
  function byId(id) { return document.getElementById(id); }
  function storageFor(name) { try { return root[name]; } catch (e) { return null; } }
  function stored(storage, key) { try { return storage.getItem(key); } catch (e) { return null; } }
  function cache(id) {
    id = id || state.d;
    if (!state.caches.has(id)) state.caches.set(id, { items: new Map(), thumbs: new Map(), rev: 0, loaded: false });
    return state.caches.get(id);
  }
  function groups() {
    if (!state.d) return [];
    var result = new Map();
    cache().items.forEach(function (item) { if (!result.has(item.pid)) result.set(item.pid, []); result.get(item.pid).push(item); });
    return Array.from(result.values(), function (photos) {
      photos.sort(function (a, b) { return a.n - b.n; });
      return Object.assign({}, photos[0], { photos: photos });
    }).sort(function (a, b) { return b.no - a.no; });
  }
  function filtered() {
    var f = state.filters;
    return groups().filter(function (p) {
      var at = String(p.at || '').replace(/\//g, '-').replace(' ', 'T');
      return (f.hidden || !p.hidden) && (!f.categories.length || f.categories.includes(p.cat)) &&
        (!f.statuses.length || f.statuses.includes(p.status)) && (!f.urgent || p.urgent) &&
        (!f.from || at >= f.from) && (!f.to || at <= f.to + ':59') &&
        (!f.person || (p.who + ' ' + p.org).toLocaleLowerCase().includes(f.person.toLocaleLowerCase())) &&
        (!f.keyword || (p.note + ' ' + p.memo).toLocaleLowerCase().includes(f.keyword.toLocaleLowerCase()));
    });
  }
  function targets() { var posts = filtered(); return state.selected.size ? posts.filter(function (p) { return state.selected.has(p.pid); }) : posts; }
  function currentDisaster() { return state.disasters.find(function (d) { return d.id === state.d; }); }
  function isCurrent() { return !!state.settings.current && state.settings.current.id === state.d; }
  function persist() {
    if (!store || !state.token) return;
    // パスワードは保存しない。通行証と設定は利用者が選んだ同じ記憶先へ置く。
    var settings = Object.assign({}, state.settings);
    try { store.setItem('spm-admin', JSON.stringify({ token: state.token, settings: settings, disasters: state.disasters, version: state.version, d: state.d })); } catch (e) { dom.toast('このPCに記憶できませんでした。この画面を開いている間は使えます。'); }
  }
  function clearStored() {
    ['localStorage', 'sessionStorage'].forEach(function (name) { try { var storage = storageFor(name); if (storage) storage.removeItem('spm-admin'); } catch (e) { /* 保存が無効なPCでも終了する。 */ } });
  }
  function versionNotice() {
    var expected = root.SPM_CONFIG.expectedGasVersion;
    dom.banner('warning', state.version && state.version !== expected ? 'GAS の版（' + state.version + '）が、このページに必要な版（' + expected + '）と違います。管理担当の方は、手引き01の「コードを直したとき」を見てください。' : '', 'version-banner');
    dom.banner('warning', state.settings.codeComplete === false ? '受付の仕組みの準備が完了していません。管理担当の方は、手引き01に沿ってCode.gsを全部貼り直し、公開し直してください。' : '', 'complete-banner');
  }
  function renderHeader() {
    var select = byId('disaster-select'); dom.clear(select);
    var defs = [['受付中', function (d) { return state.settings.current && d.id === state.settings.current.id; }], ['過去の災害', function (d) { return d.kind !== '訓練' && (!state.settings.current || d.id !== state.settings.current.id); }], ['訓練', function (d) { return d.kind === '訓練' && (!state.settings.current || d.id !== state.settings.current.id); }]];
    defs.forEach(function (def) {
      var list = state.disasters.filter(def[1]); if (!list.length) return;
      var group = el('optgroup', { label: def[0] });
      list.forEach(function (d) { group.appendChild(el('option', { value: d.id, text: d.name + '（' + String(d.start).slice(0, 10) + '〜' + String(d.end || '').slice(0, 10) + '・' + d.posts + '件）' })); });
      select.appendChild(group);
    });
    select.value = state.d; select.disabled = !state.disasters.length;
    var accepting = state.settings.accepting, badge = byId('acceptance');
    badge.textContent = accepting ? '受付中' : '停止中'; badge.className = 'badge ' + (accepting ? 'accepting' : 'warning');
    var d = currentDisaster();
    dom.banner('warning', d && !isCurrent() ? '過去の災害『' + d.name + '』を表示中（新しい投稿はここには入りません）' : '', 'past-banner');
    versionNotice();
  }
  function render() {
    if (!state.token) return;
    renderHeader();
    var posts = filtered(), all = groups(), visible = new Set(posts.map(function (p) { return p.pid; }));
    state.selected.forEach(function (pid) { if (!visible.has(pid)) state.selected.delete(pid); });
    byId('result-count').textContent = '表示 ' + posts.length + ' / ' + all.length + '投稿（写真・動画 ' + posts.reduce(function (n, p) { return n + p.photos.length; }, 0) + '件）' + (state.selected.size ? '・選択 ' + state.selected.size + '投稿' : '');
    var unread = posts.filter(function (p) { return state.unread.has(state.d + ':' + p.pid); });
    byId('new-notice').hidden = !unread.length; byId('new-notice').textContent = '新着 ' + unread.length + '件';
    S.adminMap.render(posts); S.adminViews.render(posts);
  }
  function setView(view) {
    state.view = view;
    ['map', 'tiles', 'list'].forEach(function (name) { byId(name + '-view').hidden = view !== name; });
    document.querySelectorAll('[data-view]').forEach(function (button) { var active = button.dataset.view === view; button.classList.toggle('secondary', !active); button.setAttribute('aria-pressed', String(active)); });
    render();
    if (view === 'map') {
      S.adminMap.resize();
      root.setTimeout(function () { if (state.token && state.view === 'map' && state.d && cache().loaded) S.adminMap.initialView(groups()); }, 0);
    }
  }
  function logout(message) {
    state.epoch++; state.token = ''; state.settings = {}; state.disasters = []; state.d = ''; state.sound = false;
    state.caches.clear(); state.photos.clear(); state.unread.clear(); state.opened.clear(); state.selected.clear();
    loading.clear(); root.clearTimeout(timer); root.clearTimeout(stateTimer); stateLoading = null; clearStored(); S.adminViews.close(); S.adminMap.destroy();
    byId('print-mode').hidden = true; byId('admin-app').hidden = true; byId('login').hidden = false;
    dom.clear(byId('print-pages')); dom.clear(byId('summary-panel')); dom.clear(byId('tiles-view')); dom.clear(byId('list-view'));
    ['past-banner', 'connection-banner', 'version-banner', 'complete-banner', 'current-banner'].forEach(function (id) { dom.banner('warning', '', id); });
    byId('login-error').textContent = message || ''; byId('admin-pass').value = ''; byId('admin-pass').focus();
  }
  async function request(action, payload, options) {
    var token = state.token, epoch = state.epoch;
    var reply = await S.api(action, Object.assign({}, payload, { token: token }), options);
    if (epoch !== state.epoch || token !== state.token) return { ok: false, error: 'stale', message: '操作を終了しました。' };
    if (reply.error === 'auth') logout('もう一度パスワードを入れてください。');
    return reply;
  }
  function cleanRemoved(id) {
    var data = cache(id), pids = new Set(Array.from(data.items.values(), function (r) { return r.pid; }));
    data.thumbs.forEach(function (value, key) { if (!data.items.has(key)) data.thumbs.delete(key); });
    S.mediaCache.prune(id, new Set(data.items.keys()));
    [state.unread, state.opened].forEach(function (set) { set.forEach(function (key) { if (key.startsWith(id + ':') && !pids.has(key.slice(id.length + 1))) set.delete(key); }); });
  }
  function merge(id, reply, notify, replace) {
    var data = cache(id), existing = new Set(Array.from(data.items.values(), function (r) { return r.pid; })), fresh = new Set();
    if (Number(reply.rev) < Math.max(data.rev, data.minRev || 0)) return fresh;
    if (replace || reply.full === true) { data.items.clear(); data.thumbs.clear(); }
    (reply.items || []).forEach(function (r) {
      var old = data.items.get(r.id);
      if (old && Number(old.rev) > Number(r.rev)) return;
      data.items.set(r.id, r);
      if (notify && !existing.has(r.pid) && !state.opened.has(id + ':' + r.pid)) { fresh.add(r.pid); state.unread.add(id + ':' + r.pid); }
    });
    Object.keys(reply.thumbs || {}).forEach(function (key) { data.thumbs.set(key, reply.thumbs[key]); });
    if (replace || reply.full === true) cleanRemoved(id);
    if (reply.disaster) {
      var index = state.disasters.findIndex(function (d) { return d.id === id; });
      if (index >= 0) state.disasters[index] = reply.disaster;
    }
    data.rev = Math.max(data.rev, Number(reply.rev) || 0); data.loaded = true;
    if (fresh.size && state.sound) beep();
    persist(); return fresh;
  }
  async function load(full) {
    if (!state.token || !state.d) { render(); return; }
    var id = state.d, epoch = state.epoch, key = epoch + ':' + id;
    if (loading.has(key)) {
      await loading.get(key);
      if (full && state.token && state.epoch === epoch && state.d === id) return load(true);
      return;
    }
    var task = loadData(full, id); loading.set(key, task);
    try { await task; } finally { if (loading.get(key) === task) loading.delete(key); }
  }
  async function loadData(full, id) {
    byId('load-state').textContent = '読み込み中…';
    var data = cache(id), wasLoaded = data.loaded;
    var reply = await request('list', { d: id, since: full ? 0 : data.rev });
    if (reply.error === 'stale' || !state.token) return;
    if (!reply.ok) {
      if (state.d === id) byId('load-state').textContent = reply.message;
      if (reply.error === 'network' || reply.error === 'server') dom.banner('error', 'サーバーに接続できません（自動でやり直します）', 'connection-banner');
      return;
    }
    var fresh = merge(id, reply, wasLoaded && !full, full);
    dom.banner('error', '', 'connection-banner');
    if (id === state.d) {
      byId('load-state').textContent = '最終更新 ' + S.util.formatJst(new Date()).slice(11);
      render(); S.adminViews.refreshDetail(); S.adminMap.initialView(groups()); S.adminMap.ripple(fresh); prefetchRecent();
    }
  }
  function schedule() {
    root.clearTimeout(timer); if (!state.token) return;
    var seconds = document.hidden ? 60 : S.api.pollSeconds(state.settings.pollSeconds || 20);
    timer = root.setTimeout(async function () {
      await load(false);
      schedule();
    }, Math.max(1, seconds) * 1000);
  }
  async function refreshState() {
    if (!state.token || configuring) return false;
    if (stateLoading) return stateLoading;
    var task = (async function () {
      var reply = await request('state', {});
      if (!reply.ok) {
        if (state.token && reply.error !== 'stale') dom.banner('error', 'サーバーに接続できません（自動でやり直します）', 'connection-banner');
        return false;
      }
      var previous = (state.settings.current || {}).id || '';
      state.settings = reply.settings; state.disasters = reply.disasters; state.version = reply.version;
      if (previous !== ((state.settings.current || {}).id || '')) dom.banner('warning', '受付中の災害が変わりました。表示する災害は「表示する災害・訓練」で選び直してください。', 'current-banner');
      persist(); render(); S.adminViews.refreshSettings(); schedule();
      dom.banner('error', '', 'connection-banner');
      return true;
    })();
    stateLoading = task;
    try { return await task; } finally { if (stateLoading === task) stateLoading = null; }
  }
  function scheduleState() {
    root.clearTimeout(stateTimer);
    if (!state.token || document.hidden) return;
    stateTimer = root.setTimeout(async function () { await refreshState(); scheduleState(); }, 60000);
  }
  async function switchDisaster(id) {
    if (!state.token) return;
    S.adminViews.close(); S.adminMap.cancelEdit();
    S.mediaCache.clear(); state.d = id; state.selected.clear(); S.adminMap.resetView();
    render(); if (cache().loaded) S.adminMap.initialView(groups()); persist(); await load(false); schedule();
  }
  async function update(pid, patch, disasterId) {
    var id = disasterId || state.d, reply = await request('update', { d: id, pid: pid, patch: patch });
    if (!reply.ok) { if (state.token) dom.toast(reply.message); return false; }
    // updateの更新番号は一覧全体の取得位置にしない。間に届いた他の投稿を次のlistで拾う。
    var data = cache(id);
    if (Number(reply.rev) < (data.minRev || 0)) return false;
    (reply.items || []).forEach(function (r) { var old = data.items.get(r.id); if (!old || Number(r.rev) >= Number(old.rev)) data.items.set(r.id, r); });
    if (state.d === id) render(); dom.toast('保存しました。'); return true;
  }
  async function remove(ids, disasterId) {
    var id = disasterId || state.d, data = cache(id);
    var reply = await request('remove', { d: id, ids: ids });
    if (!reply.ok) { if (state.token) dom.toast(S.util.userMessage(reply, '削除できませんでした。もう一度お試しください。')); return false; }
    var numbers = new Set();
    ids.forEach(function (key) { var item = data.items.get(key); if (item) numbers.add(item.no); data.items.delete(key); });
    // 先に始まったlistの返事で削除済みの行が戻ることを防ぐ。取得位置は進めない。
    data.minRev = Math.max(data.minRev || 0, Number(reply.rev) || 0);
    cleanRemoved(id);
    var disaster = state.disasters.find(function (d) { return d.id === id; });
    if (disaster) { disaster.photos = data.items.size; disaster.posts = new Set(Array.from(data.items.values(), function (r) { return r.pid; })).size; }
    persist();
    if (state.d === id) { render(); S.adminViews.refreshDetail(); }
    dom.toast(reply.message ? S.util.userMessage(reply, '削除後のファイルをドライブで確認してください。') : numbers.size ? Array.from(numbers, function (n) { return 'No.' + n; }).join('・') + ' を削除しました' : '対象の投稿はすでに削除されています。');
    if (state.d === id) load(true).catch(function (e) { if (state.token) dom.toast(S.util.userMessage(e, '削除後の一覧を読み直せませんでした。「全部読み直す」を押してください。')); });
    return true;
  }
  async function configure(payload) {
    if (configuring) return null;
    configuring = true;
    try {
      if (stateLoading) await stateLoading;
      if (!state.token) return null;
      var reply = await request('config', payload);
      if (!reply.ok) { if (state.token) dom.toast(reply.message); return null; }
      var oldCode = state.settings.postCode;
      state.settings = Object.assign({}, reply.settings);
      if (reply.newCode !== undefined) state.settings.postCode = reply.newCode;
      else if (oldCode) state.settings.postCode = oldCode;
      state.disasters = reply.disasters || []; persist();
      if (payload.op === 'start') await switchDisaster(state.settings.current.id); else { render(); schedule(); }
      dom.toast(reply.newCode !== undefined ? '投稿用のリンクとQRも新しくなりました。配り直してください。' : '設定しました。');
      return reply;
    } finally { configuring = false; }
  }
  function photo(id, disasterId) {
    var d = disasterId || state.d, item = cache(d).items.get(id) || { id: id };
    return S.mediaCache.get(d, item, 0);
  }
  function prefetchItem(item, priority, d) {
    if (!item || !state.token || (priority >= 2 && (!state.prefetch || document.hidden))) return;
    S.mediaCache.get(d || state.d, item, priority).catch(function () { /* 詳細を開いたときに再試行し、日本語で案内する。 */ });
  }
  function prefetchRecent() {
    if (!state.prefetch || document.hidden) return;
    groups().filter(function (p) { return !p.hidden; }).slice(0, 12).forEach(function (p) { if (p.photos[0].kind !== 'video') prefetchItem(p.photos[0], 3); });
  }
  function prefetchPost(pid) { var p = groups().find(function (p) { return p.pid === pid; }); if (p) prefetchItem(p.photos[0], 2); }
  function hover(node, pid) {
    var timeout, d = state.d;
    node.addEventListener('mouseenter', function () { timeout = root.setTimeout(function () { if (node.isConnected && state.d === d) prefetchPost(pid); }, 200); });
    node.addEventListener('mouseleave', function () { root.clearTimeout(timeout); });
  }
  function enablePrefetch(enabled) {
    state.prefetch = enabled;
    try { root.localStorage.setItem('spm-prefetch', enabled ? 'on' : 'off'); } catch (e) { /* 保存できなくても今の画面では切り替える。 */ }
    S.mediaCache.resume(); if (enabled) prefetchRecent();
  }
  function markOpened(pid) { state.unread.delete(state.d + ':' + pid); state.opened.add(state.d + ':' + pid); render(); }
  async function syncPostPage() {
    if (root.location.protocol !== 'https:') return;
    var url = new root.URL('index.html', root.location.href); url.search = ''; url.hash = '';
    if (url.href !== state.settings.postPageUrl) await configure({ op: 'postPageUrl', url: url.href });
  }
  function enableSound(enabled) {
    state.sound = enabled;
    if (enabled) {
      try { var Audio = root.AudioContext || root.webkitAudioContext; if (!audio) audio = new Audio(); audio.resume().catch(function () { dom.toast('音を有効にできませんでした。'); }); }
      catch (e) { state.sound = false; dom.toast('このPCでは通知音を使えません。'); }
    }
  }
  function beep() {
    if (!audio) return;
    try { var oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.frequency.value = 880; gain.gain.setValueAtTime(0.06, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12); oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.14); } catch (e) { /* 通知は文字でも表示する。 */ }
  }
  async function enter() {
    byId('login').hidden = true; byId('admin-app').hidden = false;
    S.adminMap.init(); render(); await load(false); if (!state.token) return;
    await refreshState(); if (!state.token) return;
    await syncPostPage(); schedule(); scheduleState();
  }
  async function login(event) {
    event.preventDefault(); var button = byId('login-button'); button.disabled = true; byId('login-error').textContent = '';
    var pass = byId('admin-pass').value; byId('admin-pass').value = '';
    var reply = await S.api('login', { pass: pass }); pass = '';
    button.disabled = false;
    if (!reply.ok) {
      byId('login-error').textContent = reply.error === 'auth' ? 'パスワードが違います' : reply.error === 'locked' ? 'しばらく入れません（あと約' + reply.retryMinutes + '分）' : reply.message;
      return;
    }
    clearStored(); state.epoch++; state.token = reply.token; state.settings = reply.settings; state.disasters = reply.disasters; state.version = reply.version;
    store = storageFor(byId('remember').checked ? 'localStorage' : 'sessionStorage');
    if (!store) dom.toast('このPCではログインした状態を記憶できません。画面を開いている間は使えます。');
    state.d = state.settings.current ? state.settings.current.id : state.disasters.length ? state.disasters[0].id : '';
    persist(); setView(state.view); await enter();
  }
  async function init() {
    byId('app-name').textContent = root.SPM_CONFIG.appName;
    S.adminViews.init();
    byId('login-form').addEventListener('submit', function (event) { login(event).catch(function () { byId('login-button').disabled = false; byId('login-error').textContent = '画面の準備ができませんでした。全部読み直してください。'; }); });
    byId('logout').addEventListener('click', function () { logout(); });
    byId('disaster-select').addEventListener('change', function (event) { switchDisaster(event.target.value); });
    byId('reload').addEventListener('click', async function () { var button = byId('reload'); button.disabled = true; try { if (await refreshState()) await load(true); scheduleState(); } finally { button.disabled = false; } });
    document.querySelectorAll('[data-view]').forEach(function (button) { button.addEventListener('click', function () { setView(button.dataset.view); }); });
    byId('new-notice').addEventListener('click', function () { var p = filtered().find(function (item) { return state.unread.has(state.d + ':' + item.pid); }); if (p) S.adminMap.focus(p.pid); });
    document.addEventListener('visibilitychange', function () { schedule(); scheduleState(); S.mediaCache.resume(); if (!document.hidden) { prefetchRecent(); refreshState(); } });
    root.addEventListener('online', function () { if (isCurrent()) load(false); schedule(); });
    if (!S.api.getUrl()) { byId('login-error').textContent = '設定が済んでいません（config.js に GAS の URL を入れてください）'; byId('login-button').disabled = true; return; }
    var snapshot;
    for (var storage of [storageFor('sessionStorage'), storageFor('localStorage')]) {
      try { snapshot = JSON.parse(stored(storage, 'spm-admin')); } catch (e) { snapshot = null; }
      if (snapshot && snapshot.token && snapshot.settings && Array.isArray(snapshot.disasters)) { store = storage; break; }
    }
    if (snapshot && snapshot.token && store) {
      state.token = snapshot.token; state.settings = snapshot.settings; state.disasters = snapshot.disasters; state.version = snapshot.version;
      state.d = snapshot.d || (state.settings.current || {}).id || (state.disasters[0] || {}).id || '';
      var ping = await S.api.ping();
      if (ping.ok) { state.version = ping.version; state.settings.codeComplete = ping.codeComplete; state.settings.accepting = ping.accepting; }
      await enter();
    }
  }
  S.admin = { state: state, byId: byId, cache: cache, groups: groups, filtered: filtered, targets: targets, currentDisaster: currentDisaster, isCurrent: isCurrent, render: render, setView: setView, request: request, update: update, remove: remove, configure: configure, refreshState: refreshState, photo: photo, hover: hover, prefetchPost: prefetchPost, prefetchItem: prefetchItem, enablePrefetch: enablePrefetch, markOpened: markOpened, enableSound: enableSound, switchDisaster: switchDisaster };
  document.addEventListener('DOMContentLoaded', function () { init().catch(function () { byId('login-error').textContent = '画面の準備ができませんでした。ページを読み直してください。'; }); });
})(typeof window !== 'undefined' ? window : globalThis);
