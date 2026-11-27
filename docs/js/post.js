(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var S = root.SPM, el = S.dom.el, main = root.document.getElementById('main');
  var settings = load('spm-post-settings', null), settingsCode = load('spm-settings-code', ''), code = load('spm-code', ''), profile = load('spm-profile', { who: '', org: '' });
  var token = '', drafts = [], view = 'home', mode = 'batch', field = {}, map = null, pin = null, manual = false, processing = false, submitting = false;
  var saving = Promise.resolve(), dirty = new Map(), objectUrls = [], target = null, picked = null, result = null, codeKind = 'text', closed = false, pending = 0, recordsVersion = 0;
  var approvedPoints = new Set(), authVersion = 0, linkUpdates = Promise.resolve(), photoPreview = null;
  function load(key, fallback) { try { var value = root.localStorage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch (e) { return fallback; } }
  function store(key, value) { try { root.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 写真はIndexedDBへ別に保存する。 */ } }
  function action(fn) { return function (event) { Promise.resolve().then(function () { return fn(event); }).catch(function (e) { S.dom.toast(S.util.userMessage(e, '処理できませんでした。もう一度お試しください。')); }); }; }
  function button(text, fn, secondary) { var node = el('button', { type: 'button', text: text, class: secondary ? 'secondary' : '' }); node.addEventListener('click', action(fn)); return node; }
  function paragraph(text, className) { return el('p', { text: text, class: className || '' }); }
  function link(text, href) { return el('a', { text: text, href: href, target: '_blank', rel: 'noopener' }); }
  function safeBackup() { try { var url = new URL(settings && settings.backupFormUrl || ''); return url.protocol === 'https:' ? url.href : ''; } catch (e) { return ''; } }
  function backup(parent) { var url = safeBackup(); if (url) parent.appendChild(paragraph('うまくいかないときは予備の窓口から送れます')); if (url) parent.appendChild(link('予備の窓口を開く', url)); }
  function announce(message, kind) { var node = S.dom.banner(kind || 'warning', message); if (message && (closed || kind === 'error')) backup(node); }
  function persist(record) {
    var copy = Object.assign({}, record);
    dirty.set(copy.id, copy);
    saving = saving.catch(function () {}).then(async function () { await S.outbox.saveDraft(copy); if (dirty.get(copy.id) === copy) dirty.delete(copy.id); }).catch(function (e) { S.dom.toast(S.util.userMessage(e, '下書きを保存できませんでした。端末の空き容量を確認してください。')); throw e; });
    // 入力中にPromiseの未処理エラーを作らず、送る直前に失敗を検査する。
    saving.catch(function () {}); return saving;
  }
  async function flush() {
    await saving.catch(function () {});
    // 容量不足などで失敗した入力は、送る直前にもう一度保存する。
    for (var copy of Array.from(dirty.values())) { await S.outbox.saveDraft(copy); if (dirty.get(copy.id) === copy) dirty.delete(copy.id); }
  }
  function isCurrent(record) { return !!(settings && settings.disaster && record.disasterId === settings.disaster.id); }
  function isPrevious(record) { return settings && settings.disaster ? !isCurrent(record) : record.state === 'other'; }
  function currentDrafts() { return drafts.filter(function (r) { return isCurrent(r) && r.mode === mode; }).sort(function (a, b) { return a.createdAt - b.createdAt || a.order - b.order; }); }
  function previousLabel(record) { return '前の受付' + (record.disasterName ? '（' + record.disasterName + '）' : ''); }
  function previousGroups(records) {
    var groups = new Map();
    records.filter(isPrevious).forEach(function (r) { var key = r.disasterId || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); });
    return Array.from(groups.values());
  }
  function defaults() { return { cat: settings && settings.categories && settings.categories[0] ? settings.categories[0].name : 'その他', urgent: false, note: '', lat: null, lng: null, acc: null, src: null }; }
  function validPoint(p) { return p && typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lng === 'number' && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180; }
  function mapHome() { return settings && settings.map || root.SPM_CONFIG.defaultMap; }
  function farAway(point) {
    if (!validPoint(point) || !(settings && settings.map && S.util.distanceMeters(settings.map, point) > 50000)) return true;
    var key = point.lat.toFixed(6) + ',' + point.lng.toFixed(6);
    if (approvedPoints.has(key)) return true;
    if (!root.confirm('選んだ場所が町から離れています。合っていますか？')) return false;
    approvedPoints.add(key); return true;
  }
  function positionText(p) {
    if (p.src === 'none') return '位置なし（本部であとで置く）';
    if (!validPoint(p)) return '⚠ 場所が未設定';
    var names = { exif: '📍 写真の位置情報', gps: '現在地(GPS)', map: '地図で指定', gmap: 'Googleマップ', landmark: '目印' };
    return (names[p.src] || '場所を指定済み') + '：' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6);
  }
  function image(record) {
    var url = root.URL.createObjectURL(new Blob([record.thumb], { type: 'image/jpeg' })); objectUrls.push(url);
    var img = el('img', { src: url, alt: record.kind === 'video' ? '選んだ動画' : '選んだ写真', loading: 'lazy' });
    if (record.kind !== 'video') return img;
    return el('span', { class: 'video-thumb' }, [img, el('span', { class: 'video-label', text: '▶ ' + (S.video.formatDuration(record.duration) || '動画') })]);
  }
  function previewPhoto(record, index, trigger) {
    if (photoPreview) photoPreview.close();
    var isVideo = record.kind === 'video', name = isVideo ? '動画' : '写真';
    var url = root.URL.createObjectURL(new Blob([record.img], { type: isVideo ? record.mime : 'image/jpeg' }));
    var dialog = el('dialog', { class: 'photo-preview', 'aria-label': name + ' ' + (index + 1) + 'の拡大表示' });
    var close = button('閉じる', function () { dialog.close(); }, true);
    var photo = button('', function () { dialog.close(); });
    photo.className = 'preview-image'; photo.setAttribute('aria-label', '写真を閉じる');
    var media;
    if (isVideo) { media = el('video', { src: url, controls: '', playsinline: '', class: 'preview-video', 'aria-label': name + ' ' + (index + 1) }); dialog.append(close, media); }
    else { photo.appendChild(el('img', { src: url, alt: '写真 ' + (index + 1) })); dialog.append(close, photo); }
    dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
    var overflow = root.document.body.style.overflow;
    dialog.addEventListener('close', function () {
      if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
      root.URL.revokeObjectURL(url); dialog.remove();
      root.document.body.style.overflow = overflow;
      if (photoPreview === dialog) photoPreview = null;
      if (trigger.isConnected) trigger.focus();
    }, { once: true });
    root.document.body.appendChild(dialog); dialog.showModal();
    root.document.body.style.overflow = 'hidden'; photoPreview = dialog;
  }
  function cleanup() {
    recordsVersion++;
    if (photoPreview) photoPreview.close();
    S.geo.stop(); if (map) { map.remove(); map = null; pin = null; }
    objectUrls.forEach(function (url) { root.URL.revokeObjectURL(url); }); objectUrls = [];
  }
  function navigate(next, replace) {
    if (processing || submitting) { S.dom.toast('保存が終わるまでお待ちください。'); return; }
    view = next;
    root.history[replace ? 'replaceState' : 'pushState']({ spm: next, mode: mode }, '', root.location.href);
    render();
  }
  function back() {
    if (root.history.state && root.history.state.spm && view !== 'home' && view !== 'login') root.history.back();
    else navigate('home', true);
  }
  function heading(title, withBack) {
    if (withBack) { var node = button('← 戻る', back, true); node.classList.add('back'); main.appendChild(node); }
    main.appendChild(el('h2', { text: title }));
  }
  function setField(patch) {
    Object.assign(field, patch); currentDrafts().forEach(function (r) { Object.assign(r, patch); persist(r); });
  }
  function mapPin(point, draggable, onMove) {
    pin = root.L.marker([point.lat, point.lng], { draggable: draggable }).addTo(map);
    if (onMove) pin.on('dragend', function () { var p = pin.getLatLng(); onMove({ lat: p.lat, lng: p.lng, acc: null, src: 'map' }); });
  }
  function updateFieldPosition(point, isManual) {
    if (submitting || view !== 'field') return;
    if (isManual) manual = true;
    setField({ lat: point.lat, lng: point.lng, acc: point.acc === undefined ? null : point.acc, src: isManual ? 'map' : 'gps' });
    var label = root.document.getElementById('gps-status');
    if (label) { label.textContent = isManual ? '手で直した位置' : '現在地：精度 ±' + Math.round(point.acc) + 'm' + (point.acc > 100 ? '。位置が不正確です。地図で直してください' : ''); label.className = point.acc > 100 ? 'error' : ''; }
    if (map) {
      if (!pin) { mapPin(field, true, function (p) { updateFieldPosition(p, true); }); map.setView([field.lat, field.lng], 16); }
      else pin.setLatLng([field.lat, field.lng]);
      if (!isManual) map.spm.setCurrent(point, false);
    }
    var check = root.document.getElementById('field-map-check'); if (check) { check.href = S.exporter.googleMapsUrl(field.lat, field.lng); check.hidden = false; }
    updateSendButton();
  }
  function metadata(record, onChange) {
    var box = el('div', { class: 'stack' }), categories = el('div', { class: 'categories', role: 'group', 'aria-label': '区分を選ぶ' }), choices = [];
    (settings.categories || [{ name: 'その他', color: '#6b7280' }]).forEach(function (category) {
      var dot = el('span', { class: 'category-dot', 'aria-hidden': 'true' }); dot.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(category.color) ? category.color : '#6b7280';
      var node = button('', function () { record.cat = category.name; onChange(); update(); });
      node.append(dot, el('span', { text: category.name })); node.dataset.cat = category.name; choices.push(node); categories.appendChild(node);
    });
    function update() { choices.forEach(function (node) { var selected = node.dataset.cat === record.cat; node.setAttribute('aria-pressed', String(selected)); node.lastChild.textContent = (selected ? '✓ ' : '') + node.dataset.cat; }); }
    update();
    var urgent = el('input', { type: 'checkbox', checked: !!record.urgent });
    urgent.addEventListener('change', function () { record.urgent = urgent.checked; onChange(); });
    var noteId = 'note-' + (record.id || 'field'), note = el('textarea', { id: noteId, maxlength: 500, placeholder: '例：道路が30cmほど冠水、通行止めが必要' }); note.value = record.note || '';
    note.addEventListener('input', function () { record.note = S.util.clampText(note.value, 500); onChange(); });
    box.append(paragraph('区分を1つ選んでください'), categories, el('label', { class: 'urgent-label' }, [urgent, '！ 至急（人命・通行止めなど）']), el('label', { for: noteId, text: 'コメント（任意）' }), note, paragraph('キーボードのマイクで声でも入力できます', 'muted'));
    return box;
  }
  function picker(label, capture, video) {
    var input = el('input', { type: 'file', accept: video ? 'video/*' : 'image/*', multiple: !capture && !video, 'aria-label': label });
    if (capture) input.setAttribute('capture', 'environment');
    input.addEventListener('change', action(async function () { var files = Array.from(input.files || []); input.value = ''; await addFiles(files, video); }));
    return el('label', { class: 'file-picker' }, [label, input]);
  }
  async function addFiles(files, video) {
    if (processing) return;
    processing = true;
    var importMode = mode, max = settings && settings.limits && settings.limits.maxPerPost || 20;
    root.document.querySelectorAll('input[type=file], .send-button').forEach(function (node) { node.disabled = true; });
    try {
      for (var i = 0; i < files.length; i++) {
        var file = files[i], list = currentDrafts(), key = JSON.stringify([file.name, file.size, file.lastModified]);
        if (list.some(function (r) { return r.fileKey === key; })) continue;
        if (mode === 'field' && list.length >= max) { S.dom.toast('1回の投稿は写真・動画あわせて' + max + '件までです。'); break; }
        var status = root.document.getElementById('photo-progress'); if (status) status.textContent = video ? '動画を読み取って保存しています…' : (i + 1) + ' / ' + files.length + ' 枚を縮小して保存しています…';
        var selectedPosition = mode === 'field' ? { lat: field.lat, lng: field.lng, acc: field.acc, src: field.src } : null;
        var processed;
        try { processed = video ? await S.video.process(file, settings && settings.limits && settings.limits.videoMaxMB) : await S.photo.process(file); } catch (e) { S.dom.toast(S.util.userMessage(e, '写真・動画を読み取れませんでした。別のファイルをお試しください。')); continue; }
        processed.kind = video ? 'video' : 'photo';
        var previous = list[list.length - 1], values = mode === 'field' ? field : Object.assign(defaults(), previous ? { cat: previous.cat, note: previous.note } : {});
        var record = Object.assign({}, values, processed, { id: S.util.uuid(), mode: importMode, createdAt: Date.now(), order: list.length, disasterId: settings.disaster.id, disasterName: settings.disaster.name });
        if (video && selectedPosition) Object.assign(record, selectedPosition);
        if (mode === 'batch' && processed.exif && validPoint(processed.exif)) Object.assign(record, { lat: processed.exif.lat, lng: processed.exif.lng, acc: null, src: 'exif' });
        // 次の写真を読む前に、今の1枚を確実に保存する。
        try { await persist(record); } catch (e) { dirty.delete(record.id); throw e; }
        drafts.push(record);
        renderPhotoList();
      }
    } finally {
      processing = false;
      root.document.querySelectorAll('input[type=file]').forEach(function (node) { node.disabled = false; });
      var statusEnd = root.document.getElementById('photo-progress'); if (statusEnd) statusEnd.textContent = '下書きはこの端末に保存されます。';
      updateSendButton();
    }
  }
  async function deleteDraft(record) {
    if (processing) return;
    await flush(); await S.outbox.remove('draft', record.id); drafts = drafts.filter(function (r) { return r.id !== record.id; }); renderPhotoList();
  }
  function updateSendButton() {
    var list = currentDrafts(), missing = list.filter(function (r) { return !validPoint(r) && r.src !== 'none'; }).length;
    var count = root.document.getElementById('missing-count'); if (count) count.textContent = '場所が未設定：' + missing + '件';
    var node = root.document.getElementById('send-button');
    if (node) { node.textContent = closed ? '受付停止中（送信待ちに保存）' : '送信する（' + list.length + '枚）'; node.disabled = processing || submitting || list.length === 0; node.setAttribute('aria-disabled', String(processing || submitting || list.length === 0 || missing > 0)); }
  }
  function renderPhotoList() {
    var container = root.document.getElementById('photo-list'); if (!container) return;
    container.querySelectorAll('img').forEach(function (node) { root.URL.revokeObjectURL(node.src); objectUrls = objectUrls.filter(function (url) { return url !== node.src; }); });
    S.dom.clear(container);
    currentDrafts().forEach(function (record, index, list) {
      var name = record.kind === 'video' ? '動画' : '写真';
      if (mode === 'field') {
        container.appendChild(el('figure', {}, [image(record), el('figcaption', { text: name + ' ' + (index + 1) }), button('✕ 外す', function () { return deleteDraft(record); }, true)]));
        return;
      }
      var located = validPoint(record) || record.src === 'none';
      var card = el('article', { id: 'card-' + record.id, class: 'photo-card stack' + (located ? '' : ' unset'), tabindex: '-1' });
      var locationLabel = paragraph(positionText(record), located ? 'success' : 'error');
      var choose = button('場所を決める', function () { openPlace(record.id); }, true);
      var same = button(record.kind === 'video' || index > 0 && list[index - 1].kind === 'video' ? '前と同じ場所' : '前の写真と同じ場所', async function () {
        var prev = list[index - 1];
        if (prev && validPoint(prev)) { Object.assign(record, { lat: prev.lat, lng: prev.lng, acc: prev.acc, src: prev.src }); await persist(record); renderPhotoList(); }
      }, true); same.disabled = index === 0 || !validPoint(list[index - 1]);
      var unknown = button('場所が分からない', async function () {
        if (root.confirm('位置なしで送ります。本部が地図に置きます。よろしいですか？')) { Object.assign(record, { lat: null, lng: null, acc: null, src: 'none' }); await persist(record); renderPhotoList(); }
      }, true);
      var preview = button('', function () { previewPhoto(record, index, preview); }, true);
      preview.classList.add('photo-preview-button'); preview.setAttribute('aria-label', name + ' ' + (index + 1) + 'を大きく見る');
      preview.appendChild(image(record));
      var info = el('div', { class: 'photo-card-info' }, [el('h3', { text: name + ' ' + (index + 1) }), paragraph('撮影日時：' + record.shot + (record.exif && record.exif.takenAt ? '' : '（ファイルの日時）')), locationLabel]);
      card.append(el('div', { class: 'photo-card-heading' }, [preview, info]), choose);
      if (validPoint(record)) card.appendChild(link('Googleマップで確認', S.exporter.googleMapsUrl(record.lat, record.lng)));
      card.append(same, unknown, metadata(record, function () { persist(record); }), button('✕ この' + name + 'を外す', function () { return deleteDraft(record); }, true));
      container.appendChild(card);
    });
    updateSendButton();
  }
  function startMode(next) {
    mode = next; var list = currentDrafts(); field = defaults();
    // 下書きの動画本体や種類を、次に選ぶ写真へ引き継がない。
    if (next === 'field' && list[0]) ['lat', 'lng', 'acc', 'src', 'cat', 'urgent', 'note'].forEach(function (key) { field[key] = list[0][key]; });
    manual = field.src === 'map';
    navigate(next);
  }
  function renderHome() {
    heading('写真・動画を送る');
    var actions = el('div', { class: 'home-actions' }, [button('📷 いまいる場所で送る', function () { startMode('field'); }), button('🗂 あとで場所を決めて送る', function () { startMode('batch'); })]);
    main.appendChild(actions);
    var current = drafts.filter(isCurrent);
    if (current.length) main.appendChild(button('📝 前の続きがあります（' + current.length + '枚）', function () { startMode(current[current.length - 1].mode); }, true));
    previousGroups(drafts).forEach(function (group) {
      var hasVideo = group.some(function (r) { return r.kind === 'video'; });
      var notice = el('div', { class: 'panel warning stack previous-drafts' }, [paragraph(previousLabel(group[0]) + (hasVideo ? 'で作りかけの写真・動画が ' : 'で作りかけの写真が ') + group.length + (hasVideo ? ' 件あります' : ' 枚あります'))]);
      notice.append(button('今の受付で使う', async function () {
        await flush(); await S.outbox.useCurrent('draft', group.map(function (r) { return r.id; }), settings.disaster);
        drafts = await S.outbox.all('draft'); startMode(group[group.length - 1].mode);
      }), button('消す', async function () {
        if (!root.confirm('この前の受付の下書き ' + group.length + '枚を消します。元に戻せません。よろしいですか？')) return;
        await flush(); await S.outbox.removeMany('draft', group.map(function (r) { return r.id; })); drafts = await S.outbox.all('draft'); render();
      }, true));
      main.appendChild(notice);
    });
    var queue = button('⏳ 送信待ち ' + pending + '件', function () { navigate('queue'); }, true); queue.id = 'home-queue'; if (pending) queue.className = 'warning wide';
    var links = el('div', { class: 'stack' }, [queue, button('📝 送った記録', function () { navigate('history'); }, true), el('a', { class: 'button secondary', href: 'help.html', text: '❓ 使い方' }), button('名前・所属を変える', function () { navigate('profile'); }, true), button('合言葉を入れ直す', function () { navigate('login'); }, true)]);
    main.appendChild(links);
  }
  function profileFields(parent) {
    var who = el('input', { id: 'who', maxlength: 40, autocomplete: 'name', value: profile.who || '' });
    var org = el('input', { id: 'org', maxlength: 40, autocomplete: 'organization', value: profile.org || '' });
    parent.append(el('label', { for: 'who', text: '名前（任意）' }), who, el('label', { for: 'org', text: '所属（任意）' }), org);
    return function () { profile = { who: S.util.clampText(who.value, 40), org: S.util.clampText(org.value, 40) }; store('spm-profile', profile); };
  }
  function showLogin(message) {
    heading('合言葉を入れてください');
    var box = el('div', { class: 'stack' }), input = el('input', { id: 'code', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: codeKind === 'digits' ? 'numeric' : 'text', maxlength: 128 });
    input.value = code || ''; var error = paragraph(message || '', 'error'); error.setAttribute('role', 'alert');
    box.append(el('label', { for: 'code', text: '投稿の合言葉' }), input, error);
    var saveProfile = profileFields(box), submit = button('始める', async function () {
      submit.disabled = true; saveProfile();
      try { await login(S.util.normCode(input.value), error); } finally { submit.disabled = false; }
    });
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit.click(); }); box.appendChild(submit);
    if (pending) box.appendChild(button('⏳ 送信待ちを見る', function () { navigate('queue'); }, true));
    main.appendChild(box);
  }
  async function login(value, error) {
    var version = ++authVersion;
    var reply = await S.api('hello', { code: value });
    if (version !== authVersion) return false;
    if (reply.ok) {
      settings = reply; token = reply.token; code = value; settingsCode = value; closed = false;
      store('spm-code', code); store('spm-settings-code', settingsCode); store('spm-post-settings', settings); announce(''); renderInApp(); await S.outbox.changed();
      if (version !== authVersion) return false;
      navigate('home', true);
      S.outbox.send().catch(function (e) { S.dom.toast(S.util.userMessage(e, '送信できませんでした。もう一度お試しください。')); }); return true;
    }
    if (reply.error === 'network' && settings && value && value === settingsCode) {
      token = settings.token; announce('通信できません。前回の設定で続けます。写真・動画は送信待ちに保存できます。'); navigate('home', true); return true;
    }
    var message = reply.error === 'code' ? (error ? '合言葉が違います' : '合言葉が変わりました。新しい合言葉を入れてください') : reply.error === 'locked' ? 'しばらく確認できません（あと約' + reply.retryMinutes + '分）' : reply.message;
    if (reply.error === 'closed') { closed = true; announce('いまは投稿の受付をしていません'); }
    if (error) error.textContent = message; else { view = 'login'; render(); var p = main.querySelector('[role=alert]'); if (p) p.textContent = message; }
    return false;
  }
  function renderField() {
    mode = 'field'; heading('写真・動画と場所を確認', true);
    main.appendChild(el('div', { class: 'row media-pickers' }, [picker('📷 撮る', true), picker('🖼 写真を選ぶ', false), picker('🎥 動画', false, true)]));
    main.append(paragraph('', 'muted'), el('p', { id: 'photo-progress', role: 'status' }), el('div', { id: 'photo-list', class: 'thumb-list' }), el('p', { id: 'gps-status', text: validPoint(field) ? positionText(field) : '現在地を確認しています…', role: 'status' }));
    var mapElement = el('div', { class: 'map', 'aria-label': '投稿する場所の地図' }); main.appendChild(mapElement);
    var home = validPoint(field) ? Object.assign({}, field, { zoom: 16 }) : mapHome();
    map = S.mapbase.createMap(mapElement, Object.assign({}, home, { mobile: true, baseControl: 'above', onLocate: function (p) { manual = false; updateFieldPosition(p, false); } }));
    if (validPoint(field)) mapPin(field, true, function (p) { updateFieldPosition(p, true); });
    map.on('click', function (event) { updateFieldPosition({ lat: event.latlng.lat, lng: event.latlng.lng, acc: null }, true); });
    main.appendChild(el('div', { class: 'row' }, [button('地図で場所を決める', function () { openPlace('field'); }, true), button('現在地に戻す', async function () {
      var activeMap = map;
      try { var p = await S.geo.acquire({}); if (activeMap !== map || view !== 'field') return; manual = false; updateFieldPosition(p, false); map.setView([p.lat, p.lng], 16); }
      catch (e) { S.dom.toast(S.geo.errorMessage(e)); }
    }, true)]));
    var check = link('Googleマップで確認', validPoint(field) ? S.exporter.googleMapsUrl(field.lat, field.lng) : '#'); check.id = 'field-map-check'; check.hidden = !validPoint(field); main.appendChild(check);
    main.appendChild(metadata(field, function () { setField({ cat: field.cat, urgent: field.urgent, note: field.note }); }));
    sendFooter(); renderPhotoList();
    S.geo.watch(function (point, error) {
      if (point) { if (!manual) updateFieldPosition(point, false); else if (map) map.spm.setCurrent(point, false); }
      else { var status = root.document.getElementById('gps-status'); if (status) { status.textContent = S.util.userMessage(error, '現在地を確認できませんでした。場所を指定してください。'); status.className = 'error'; } }
    });
  }
  function renderBatch() {
    mode = 'batch'; heading('写真ごとに場所を決める', true);
    main.append(el('div', { class: 'row media-pickers' }, [picker('🖼 写真を選ぶ', false), picker('🎥 動画', false, true)]), paragraph('動画も1本ずつ場所を決めます。', 'muted'), el('p', { id: 'photo-progress', role: 'status' }), el('p', { id: 'missing-count', role: 'status' }), el('div', { id: 'photo-list', class: 'stack' }));
    sendFooter(); renderPhotoList();
  }
  function sendFooter() {
    var send = button('', submitPhotos); send.id = 'send-button'; send.className = 'wide send-button';
    main.appendChild(el('div', { class: 'send-footer stack' }, [paragraph('③ 場所と内容を確かめて送ってください'), send]));
  }
  function openPlace(id) { target = id; var record = id === 'field' ? field : drafts.find(function (r) { return r.id === id; }); picked = validPoint(record) ? Object.assign({}, record) : null; navigate('place'); }
  function renderPlace() {
    heading('② 場所を決める', true); main.classList.add('place-view');
    if (!target) { navigate(mode, true); return; }
    var fields = el('div', { class: 'place-fields stack' }), landmarks = el('select', { id: 'landmark', 'aria-label': '目印から選ぶ' }, [el('option', { value: '', text: '目印から選ぶ' })]);
    (settings.landmarks || []).forEach(function (item, i) { landmarks.appendChild(el('option', { value: i, text: item.name })); });
    var input = el('textarea', { id: 'location-text', rows: 2, placeholder: '37.0412, 136.7790 または Googleマップのリンク' }), status = paragraph(picked ? positionText(picked) : '地図を押して場所を選んでください'); status.setAttribute('role', 'status');
    var mapElement = el('div', { class: 'map place-map', 'aria-label': '場所を決める地図' });
    var confirm = button('この場所に決める', async function () {
      if (!validPoint(picked)) { S.dom.toast('地図を押すか、座標や目印から場所を選んでください。'); return; }
      if (!farAway(picked)) return;
      var patch = { lat: picked.lat, lng: picked.lng, acc: picked.acc === undefined ? null : picked.acc, src: picked.src || 'map' };
      if (target === 'field') { manual = true; setField(Object.assign(patch, { src: 'map' })); }
      else { var r = drafts.find(function (record) { return record.id === target; }); if (r) { Object.assign(r, patch); await persist(r); } }
      await flush(); root.history.back();
    }); confirm.className = 'wide';
    var check = link('Googleマップで確認', picked ? S.exporter.googleMapsUrl(picked.lat, picked.lng) : '#'); check.hidden = !picked;
    function pick(p, center) {
      picked = { lat: Math.round(p.lat * 1e6) / 1e6, lng: Math.round(p.lng * 1e6) / 1e6, acc: p.acc === undefined ? null : p.acc, src: p.src || 'map' };
      if (!pin) mapPin(picked, true, function (position) { pick(position, false); }); else pin.setLatLng([picked.lat, picked.lng]);
      if (center) map.setView([picked.lat, picked.lng], 16);
      status.textContent = positionText(picked); check.href = S.exporter.googleMapsUrl(picked.lat, picked.lng); check.hidden = false;
    }
    landmarks.addEventListener('change', function () { if (landmarks.value !== '') { var p = settings.landmarks[Number(landmarks.value)]; pick({ lat: p.lat, lng: p.lng, src: 'landmark' }, true); } });
    var read = button('読み取る', async function () {
      var activeMap = map;
      var parsed = S.coords.parseLocationText(input.value);
      if (parsed && parsed.needsResolve) { read.disabled = true; try { parsed = await S.api('resolve', { token: token, url: parsed.url }); if (activeMap !== map || view !== 'place') return; if (!parsed.ok) { S.dom.toast(parsed.message); if (parsed.error === 'code') handleReply(parsed); return; } } finally { read.disabled = false; } }
      if (!validPoint(parsed)) { S.dom.toast('座標を読み取れませんでした。Googleマップの座標かリンクを入れてください。'); return; }
      pick({ lat: parsed.lat, lng: parsed.lng, src: 'gmap' }, true);
    }, true);
    fields.append(el('label', { for: 'landmark', text: '目印から選ぶ' }), landmarks, el('label', { for: 'location-text', text: 'Googleマップの座標やリンクを貼る' }), input, read);
    main.append(fields, mapElement, status, check, confirm);
    var home = picked ? Object.assign({}, picked, { zoom: 16 }) : mapHome();
    map = S.mapbase.createMap(mapElement, Object.assign({}, home, { mobile: true, baseControl: 'above', onLocate: function (p) { pick(p, true); } }));
    if (picked) pick(picked, false);
    map.on('click', function (event) { pick({ lat: event.latlng.lat, lng: event.latlng.lng, src: 'map' }, false); });
  }
  function groupRecords(list) {
    var groups = [], previousKey = null, group, max = settings.limits && settings.limits.maxPerPost || 20;
    list.forEach(function (r) {
      var key = JSON.stringify([r.lat, r.lng, r.cat, !!r.urgent, r.note]);
      if (mode === 'field') key = '現地';
      if (!group || key !== previousKey || group.length >= max) { group = []; groups.push(group); previousKey = key; }
      group.push(r);
    });
    var records = [];
    groups.forEach(function (group) { var pid = S.util.uuid(); group.forEach(function (r, i) { records.push(Object.assign({}, r, { pid: pid, n: i + 1, of: group.length, who: profile.who || '', org: profile.org || '', ua: S.util.deviceKind(root.navigator.userAgent) })); }); });
    return records;
  }
  async function submitPhotos() {
    if (processing || submitting) return;
    var list = currentDrafts(); if (!list.length) return;
    var missing = list.find(function (r) { return !validPoint(r) && r.src !== 'none'; });
    if (missing) {
      S.dom.toast('場所が未設定です。「場所を決める」で指定してください。');
      var card = root.document.getElementById('card-' + missing.id); if (card) { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); card.focus(); }
      return;
    }
    if (list.some(function (r) { return !farAway(r); })) return;
    submitting = true; S.geo.stop(); updateSendButton();
    main.querySelectorAll('button, input, textarea, select').forEach(function (node) { node.disabled = true; });
    try {
      await flush(); await S.outbox.enqueue(groupRecords(list));
      var ids = new Set(list.map(function (r) { return r.id; })); drafts = drafts.filter(function (r) { return !ids.has(r.id); });
      result = { total: list.length, sent: 0, waiting: list.length, nos: [] };
      submitting = false; navigate('sending', true);
      var delivered = [];
      try { if (!closed) { var outcome = await S.outbox.send(); delivered = outcome.sent; } } catch (e) { S.dom.toast(S.util.userMessage(e, '送信できませんでした。もう一度お試しください。')); }
      var history = (await S.outbox.all('history')).filter(function (r) { return ids.has(r.id); });
      var successful = new Map(); history.concat(delivered).forEach(function (r) { if (ids.has(r.id)) successful.set(r.id, r); });
      result.sent = successful.size; result.waiting = list.length - successful.size; result.nos = Array.from(new Set(Array.from(successful.values()).map(function (r) { return r.no; }))).sort(function (a, b) { return a - b; });
      if (view === 'sending') navigate('result', true);
    } finally { submitting = false; if (view === 'field' || view === 'batch') render(); else updateSendButton(); }
  }
  function renderSending() {
    heading('③ 送信しています');
    main.append(el('p', { id: 'send-progress', text: '0 / ' + (result ? result.total : 0) + ' 枚', role: 'status' }), el('progress', { id: 'send-bar', value: 0, max: result ? result.total : 1 }), el('p', { id: 'video-send-progress', role: 'status' }), paragraph('このままお待ちください。写真・動画は送信待ちに残ります。'));
  }
  function renderResult() {
    heading('送信の結果'); result = result || { sent: 0, waiting: pending, nos: [] };
    if (result.sent) main.appendChild(paragraph('✓ ' + result.sent + '枚 送信しました（受付番号 ' + result.nos.map(function (n) { return 'No.' + n; }).join('・') + '）', 'success result-title'));
    if (result.waiting) { main.appendChild(paragraph('⏳ ' + result.waiting + '枚は送信待ちに入れました。電波が戻ると自動で送ります', 'panel warning')); backup(main); }
    main.appendChild(el('div', { class: 'stack' }, [button('ホームに戻る', function () { navigate('home', true); }), button('送信待ちを見る', function () { navigate('queue'); }, true)]));
  }
  async function refreshAuth() {
    if (!code) { navigate('login'); return false; }
    var version = ++authVersion;
    var reply = await S.api('hello', { code: code });
    if (version !== authVersion) return false;
    if (!reply.ok) { handleReply(reply); if (['network', 'server', 'busy'].indexOf(reply.error) >= 0) S.dom.toast(reply.message || '通信できません。電波が届く所でもう一度お試しください。'); return false; }
    settings = reply; token = reply.token; settingsCode = code; closed = false;
    store('spm-settings-code', settingsCode); store('spm-post-settings', settings); announce(''); await S.outbox.changed(); return true;
  }
  async function renderRecords(history) {
    var version = recordsVersion;
    heading(history ? '📝 送った記録' : '⏳ 送信待ち', true);
    if (!history) {
      main.appendChild(button('今すぐ送る', async function () { if (await refreshAuth()) { await S.outbox.send(); if (view === 'queue') render(); } }));
      if (closed) backup(main);
    }
    var listElement = el('div', { class: 'stack' }); main.appendChild(listElement);
    var records = await S.outbox.all(history ? 'history' : 'outbox');
    if (version !== recordsVersion || view !== (history ? 'history' : 'queue')) return;
    records.sort(function (a, b) { return (b.sentAt || b.createdAt) - (a.sentAt || a.createdAt); });
    if (!records.length) listElement.appendChild(paragraph(history ? 'まだ送った記録はありません。' : '送信待ちはありません。'));
    if (!history) previousGroups(records).forEach(function (group) {
      var notice = el('div', { class: 'panel warning stack previous-outbox' }, [paragraph(previousLabel(group[0]) + 'の分 ' + group.length + '件')]);
      notice.append(button('今の受付で送る', async function () {
        if (S.outbox.isSending()) { S.dom.toast('送信が終わってから、もう一度お試しください。'); return; }
        if (!await refreshAuth()) return;
        await S.outbox.useCurrent('outbox', group.map(function (r) { return r.id; }), settings.disaster);
        await S.outbox.send(); if (view === 'queue') render();
      }), button('消す', async function () {
        if (S.outbox.isSending()) { S.dom.toast('送信が終わってから消してください。'); return; }
        if (!root.confirm('この前の受付の送信待ち ' + group.length + '件を消します。元に戻せません。よろしいですか？')) return;
        await S.outbox.removeMany('outbox', group.map(function (r) { return r.id; })); if (view === 'queue') render();
      }, true));
      listElement.appendChild(notice);
      group.forEach(function (r) { notice.appendChild(el('article', { class: 'queue-row' }, [image(r), el('div', {}, [paragraph(S.util.formatJst(new Date(r.createdAt))), paragraph(r.cat), paragraph('今の受付で送るか、消すかを選んでください。')])])); });
    });
    records.filter(function (r) { return history || !isPrevious(r); }).forEach(function (r) {
      var name = r.kind === 'video' ? '動画' : '写真';
      var body = el('div', {}, [paragraph(history ? '✓ 受付番号 No.' + r.no : r.state === 'bad' ? '！ 送れない' + name : '⏳ 送信待ち'), paragraph(S.util.formatJst(new Date(r.sentAt || r.createdAt))), paragraph(r.cat), paragraph(r.lastReason || (history ? '送信済み' : '電波が戻ると自動で送ります'))]);
      if (!history && r.kind === 'video') body.appendChild(el('p', { id: 'video-progress-' + r.id, role: 'status', text: S.video.progressText(r.size, r.videoNext || 0) }));
      if (!history) body.appendChild(button('この' + name + 'を消す', async function () {
        if (S.outbox.isSending()) { S.dom.toast('送信が終わってから消してください。'); return; }
        if (root.confirm('この' + name + 'を送信待ちから消します。元に戻せません。よろしいですか？')) { await S.outbox.remove('outbox', r.id); render(); }
      }, true));
      listElement.appendChild(el('article', { class: 'queue-row' }, [image(r), body]));
    });
  }
  function render() {
    cleanup(); S.dom.clear(main); main.className = '';
    root.document.getElementById('disaster-name').textContent = settings && settings.disaster ? settings.disaster.name + (settings.disaster.kind === '訓練' ? '（訓練）' : '') : '';
    root.document.getElementById('steps').textContent = view === 'place' ? '① 写真 → 【② 場所】 → ③ 送る' : view === 'sending' || view === 'result' ? '① 写真 → ② 場所 → 【③ 送る】' : '① 写真 → ② 場所 → ③ 送る';
    if (!settings && !['login', 'queue', 'history'].includes(view)) view = 'login';
    if (view === 'login') showLogin();
    else if (view === 'home') renderHome();
    else if (view === 'profile') { heading('名前・所属を変える', true); var box = el('div', { class: 'stack' }), save = profileFields(box); box.appendChild(button('保存する', function () { save(); navigate('home', true); S.dom.toast('保存しました'); })); main.appendChild(box); }
    else if (view === 'field') renderField();
    else if (view === 'batch') renderBatch();
    else if (view === 'place') renderPlace();
    else if (view === 'sending') renderSending();
    else if (view === 'result') renderResult();
    else if (view === 'queue' || view === 'history') renderRecords(view === 'history').catch(function (e) { S.dom.toast(S.util.userMessage(e, '保存した記録を読み込めませんでした。もう一度お試しください。')); });
    else { view = 'home'; render(); return; }
    main.focus(); root.scrollTo(0, 0);
  }
  function handleReply(reply) {
    if (reply.ok) return;
    if (reply.error === 'code') { token = ''; navigate('login', true); var p = main.querySelector('[role=alert]'); if (p) p.textContent = '合言葉が変わりました。新しい合言葉を入れてください'; }
    else if (reply.error === 'closed') { closed = true; announce('いまは投稿の受付をしていません'); }
    else if (reply.error === 'limit') announce('混み合っています。写真・動画は送信待ちに残っています。');
    else if (reply.error === 'locked') announce('しばらく確認できません（あと約' + reply.retryMinutes + '分）');
    else if (reply.error === 'bad') S.dom.toast(reply.message);
  }
  function renderInApp() {
    var node = root.document.getElementById('in-app');
    if (!/ Line\/|FBAN|FBAV|Instagram/i.test(root.navigator.userAgent)) { node.hidden = true; return; }
    S.dom.clear(node); node.hidden = false;
    node.appendChild(paragraph('アプリの中では写真・動画の保存などがうまく動かないことがあります。「ブラウザで開き直す」を押してください'));
    var url = new URL('index.html', root.location.href); url.searchParams.set('openExternalBrowser', '1'); if (code) url.hash = 'k=' + encodeURIComponent(code);
    var open = el('a', { class: 'button', text: 'ブラウザで開き直す', href: url.href, target: '_blank', rel: 'noopener' }); node.appendChild(open);
  }
  function readLinkCode() {
    if (root.location.hash.indexOf('#k=') !== 0) return false;
    // 読み直しのないリンク移動でも、前の通行証と処理中のhelloを使わない。
    token = ''; authVersion++;
    try { code = S.util.normCode(decodeURIComponent(root.location.hash.slice(3))); store('spm-code', code); } catch (e) { S.dom.toast('リンクの合言葉を読み取れませんでした。手で入力してください。'); }
    root.history.replaceState(root.history.state, '', root.location.pathname + root.location.search);
    return true;
  }
  async function refreshReception() {
    announce(''); renderInApp();
    var version = authVersion, ping = await S.api.ping();
    if (version !== authVersion) return;
    if (ping.ok) { codeKind = ping.codeKind; closed = !ping.accepting; }
    if (closed) announce('いまは投稿の受付をしていません');
    if (!ping.ok && settings) announce('通信できません。前回の設定で続けます。写真・動画は送信待ちに保存できます。');
    if (code && !closed) await login(code);
    else { view = settings && code && code === settingsCode ? 'home' : 'login'; navigate(view, true); }
    await S.outbox.changed();
    if (drafts.some(isCurrent)) S.dom.toast('前の続きがあります。ホームの「前の続き」から戻れます。');
  }
  function openChangedLink() {
    if (!readLinkCode()) return;
    var version = authVersion;
    linkUpdates = linkUpdates.catch(function () {}).then(async function () {
      // 写真の保存・送信が終わってから、受付と下書きの表示を切り替える。
      while (processing || submitting) await new Promise(function (resolve) { root.setTimeout(resolve, 100); });
      await flush();
      if (S.outbox.isSending()) await S.outbox.send();
      if (version !== authVersion) return;
      drafts = await S.outbox.all('draft');
      if (version !== authVersion) return;
      await refreshReception();
    });
    linkUpdates.catch(function (e) { announce(S.util.userMessage(e, 'リンクを開き直せませんでした。もう一度お試しください。'), 'error'); });
  }
  async function initialize() {
    readLinkCode();
    renderInApp();
    if (!S.api.getUrl()) { S.dom.clear(main); heading('設定が済んでいません'); main.appendChild(paragraph('受付の接続先が設定されていません。管理担当の方に確認してください。', 'error')); return; }
    if ('serviceWorker' in root.navigator && (root.location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(root.location.hostname))) root.navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { S.dom.toast('オフライン用の保存ができませんでした。通信できる場所でお使いください。'); });
    if (root.navigator.storage && root.navigator.storage.persist) root.navigator.storage.persist().catch(function () {});
    try { drafts = await S.outbox.all('draft'); pending = (await S.outbox.all('outbox')).length; } catch (e) { announce(S.util.userMessage(e, '保存した記録を読み込めませんでした。空き容量とブラウザの設定を確認してください。'), 'error'); S.dom.clear(main); heading('写真・動画を保存できません'); main.appendChild(paragraph('Safari／Chromeで開き直し、空き容量とブラウザの設定を確認してください。')); return; }
    S.outbox.start({
      getAuth: function () { return { token: closed ? '' : token, disasterId: settings && settings.disaster.id }; },
      onReply: handleReply,
      onVideoProgress: function (p) {
        var text = root.document.getElementById('video-send-progress'), queued = root.document.getElementById('video-progress-' + p.id);
        if (text) text.textContent = p.text;
        if (queued) queued.textContent = p.text;
      },
      onProgress: function (p) { var text = root.document.getElementById('send-progress'), bar = root.document.getElementById('send-bar'); if (text) text.textContent = p.completed + ' / ' + p.total + ' 枚'; if (bar) { bar.max = p.total; bar.value = p.completed; } }
    });
    root.addEventListener('spm-outbox', function (event) {
      pending = event.detail.count;
      var otherCount = event.detail.records.filter(isPrevious).length;
      S.dom.banner('warning', pending ? '⏳ 送信待ち ' + pending + '件（電波が戻ると自動で送ります）' + (otherCount ? '（前の受付の分 ' + otherCount + '件）' : '') : '', 'pending-banner');
      var homeQueue = root.document.getElementById('home-queue'); if (homeQueue) { homeQueue.textContent = '⏳ 送信待ち ' + pending + '件'; homeQueue.className = pending ? 'warning wide' : 'secondary'; }
      if (view === 'queue' && !event.detail.sending) render();
    });
    await S.outbox.changed();
    await refreshReception();
    root.addEventListener('hashchange', openChangedLink);
    // 起動中に別の合言葉入りリンクを開いた場合も取りこぼさない。
    openChangedLink();
    root.addEventListener('popstate', function (event) {
      if (processing || submitting) { root.history.pushState({ spm: view, mode: mode }, '', root.location.href); S.dom.toast('保存しています。少しお待ちください。'); return; }
      view = event.state && event.state.spm || 'home'; mode = event.state && event.state.mode || mode;
      if (view === 'sending') view = 'result';
      render();
    });
    root.addEventListener('beforeunload', function (event) { if (processing) { event.preventDefault(); event.returnValue = ''; } });
  }
  root.SPM.post = { groupRecords: groupRecords };
  initialize().catch(function (e) { announce(S.util.userMessage(e, '起動できませんでした。もう一度開き直してください。'), 'error'); });
})(typeof window !== 'undefined' ? window : globalThis);
