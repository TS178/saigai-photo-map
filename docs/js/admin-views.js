(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var S = root.SPM, dom = S.dom, el = dom.el, active = null, serial = 0;
  var statuses = ['未確認', '確認済', '対応中', '対応済'], statusClasses = ['status-new', 'status-checked', 'status-working', 'status-done'];
  var sources = { gps: '現在地(GPS)', exif: '写真の位置情報', map: '地図で指定', gmap: 'Googleマップ', landmark: '目印', none: '位置なし', admin: '管理者が修正' };
  function button(text, handler, className) {
    var node = el('button', { type: 'button', text: text, class: className || '' });
    node.addEventListener('click', async function (event) {
      event.stopPropagation(); node.disabled = true;
      try { await handler(event); } catch (e) { dom.toast(S.util.userMessage(e, '操作できませんでした。もう一度お試しください。')); }
      finally { node.disabled = node.dataset.keepDisabled === 'true'; }
    });
    return node;
  }
  function close() {
    if (!active) return;
    var previous = active; active = null; previous.closed = true;
    root.document.removeEventListener('keydown', previous.keyHandler);
    previous.overlay.remove();
    if (previous.onClose) previous.onClose();
    if (previous.focus && previous.focus.isConnected) previous.focus.focus();
  }
  function resizeDetail() { if (active && active.resize) active.resize(); }
  function modal(title, onClose) {
    close();
    var headingId = 'dialog-title-' + (++serial), overlay = el('div', { class: 'modal-overlay' });
    var dialog = el('section', { class: 'admin-dialog stack', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': headingId, tabindex: '-1' });
    var body = el('div', { class: 'dialog-body stack' }), result = { overlay: overlay, dialog: dialog, body: body, closed: false, focus: root.document.activeElement, onClose: onClose };
    dialog.append(el('div', { class: 'dialog-heading row' }, [el('h2', { id: headingId, text: title }), button('閉じる', close, 'secondary')]), body); overlay.appendChild(dialog);
    result.keyHandler = function (event) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      var nodes = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter(function (n) { return n.getClientRects().length; });
      var first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (root.document.activeElement === first || root.document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    active = result; S.admin.byId('modal-host').appendChild(overlay); root.document.addEventListener('keydown', result.keyHandler); dialog.focus(); return result;
  }
  function confirm(message, accept) {
    var box = modal('確認'); box.body.appendChild(el('p', { text: message }));
    box.body.appendChild(el('div', { class: 'row' }, [button('実行する', async function () { await accept(box); }), button('やめる', close, 'secondary')]));
  }
  function confirmRemove(photos, d, done, cancel) {
    if (!photos.length) return;
    if (photos.length > 200) { dom.toast('一度に削除できる写真・動画は200件までです。選ぶ投稿を減らしてください。'); return; }
    var numbers = Array.from(new Set(photos.map(function (p) { return p.no; }))), videos = photos.filter(function (p) { return p.kind === 'video'; }).length;
    var box = modal('削除の確認');
    box.body.append(el('p', { class: 'remove-summary', text: numbers.map(function (no) { return 'No.' + no; }).join('・') + ' の写真・動画 ' + photos.length + '件（写真' + (photos.length - videos) + '・動画' + videos + '）を削除しますか？' }), el('p', { text: '記録の行は消えます。写真・動画のファイルは Google ドライブのゴミ箱に移します（30日以内ならドライブのゴミ箱から戻せます）。' }));
    box.body.appendChild(el('div', { class: 'row' }, [button('削除する', async function () {
      var ok = await S.admin.remove(photos.map(function (p) { return p.id; }), d);
      if (!ok || box.closed) return;
      close(); if (done && S.admin.state.d === d) done();
    }, 'danger'), button('やめる', function () { close(); if (cancel && S.admin.state.d === d) cancel(); }, 'secondary')]));
  }
  function field(label, input) { return el('label', {}, [el('span', { text: label }), input]); }
  function check(label, checked, change, selectionOnly) {
    var input = el('input', { type: 'checkbox', checked: checked }); if (change) input.addEventListener('change', function () { change(input.checked); });
    return { input: input, label: el('label', { class: 'check-label' }, [input, selectionOnly ? el('span', { class: 'visually-hidden', text: label }) : label]) };
  }
  function badge(text, className) { return el('span', { class: 'badge ' + (className || ''), text: text }); }
  function statusBadge(value) { return badge(value, statusClasses[statuses.indexOf(value)] || ''); }
  function photoThumb(photo, d) {
    var b64 = S.admin.cache(d).thumbs.get(photo.id);
    var wrapper = el('span', { class: 'media-thumb' }, [b64 ? el('img', { src: 'data:image/jpeg;base64,' + b64, alt: 'No.' + photo.no + '-' + photo.n + (photo.kind === 'video' ? 'の動画' : 'の写真'), loading: 'lazy' }) : el('span', { class: 'thumb-empty', text: '画像の準備中' })]);
    if (photo.kind === 'video') wrapper.appendChild(el('span', { class: 'media-label', text: '動画' + (S.video.formatDuration(photo.duration) ? ' ' + S.video.formatDuration(photo.duration) : '') }));
    return wrapper;
  }
  function tileView(posts) {
    var area = S.admin.byId('tiles-view'); dom.clear(area);
    var photos = [];
    posts.forEach(function (p) { p.photos.forEach(function (photo) { photos.push({ p: p, photo: photo }); }); });
    photos.sort(function (a, b) { return String(b.photo.at).localeCompare(String(a.photo.at)) || b.photo.no - a.photo.no || a.photo.n - b.photo.n; });
    photos.forEach(function (row) {
      var p = row.p, node = button('', function () { detail(p.pid, row.photo.id); }, 'tile secondary' + (p.hidden ? ' is-hidden' : ''));
      node.append(photoThumb(row.photo), el('strong', { text: 'No.' + p.no + '-' + row.photo.n }), el('span', { text: row.photo.shot || row.photo.at }), badge(p.cat), statusBadge(p.status));
      if (p.urgent) node.appendChild(badge('至急', 'urgent'));
      S.admin.hover(node, p.pid); area.appendChild(node);
    });
    if (!photos.length) area.appendChild(el('p', { class: 'empty-state', text: '表示する写真はありません。絞り込みの条件も確認してください。' }));
  }
  function listView(posts) {
    var area = S.admin.byId('list-view'); dom.clear(area);
    var selected = posts.filter(function (p) { return S.admin.state.selected.has(p.pid); });
    if (selected.length) {
      var d = S.admin.state.d, photos = [];
      selected.forEach(function (p) { photos.push.apply(photos, p.photos); });
      area.appendChild(el('div', { class: 'list-remove-tools row' }, [button('選んだ投稿を削除（' + selected.length + '件）', function () { confirmRemove(photos, d); }, 'danger')]));
    }
    var table = el('table', { class: 'post-table' }), head = el('thead'), tr = el('tr'), body = el('tbody');
    var selectAll = check('表示中をすべて選ぶ', posts.length > 0 && posts.every(function (p) { return S.admin.state.selected.has(p.pid); }), function (checked) { posts.forEach(function (p) { if (checked) S.admin.state.selected.add(p.pid); else S.admin.state.selected.delete(p.pid); }); S.admin.render(); }, true);
    tr.appendChild(el('th', { scope: 'col' }, [selectAll.label]));
    [['No.', 'no'], ['受付日時', 'at'], ['区分', 'cat'], ['至急', 'urgent'], ['状況', 'status'], ['投稿者（所属）', 'who'], ['コメント', 'note'], ['写真・動画', 'count'], ['場所', 'location']].forEach(function (column) {
      var sort = S.admin.state.sort, th = el('th', { scope: 'col', 'aria-sort': sort.key === column[1] ? sort.direction === 1 ? 'ascending' : 'descending' : 'none' });
      th.appendChild(button(column[0], function () { if (sort.key === column[1]) sort.direction *= -1; else { sort.key = column[1]; sort.direction = 1; } listView(S.admin.filtered()); }, 'secondary')); tr.appendChild(th);
    });
    head.appendChild(tr);
    function value(p, key) { return key === 'count' ? p.photos.length : key === 'location' ? S.adminMap.located(p) ? p.lat : -Infinity : p[key]; }
    posts.slice().sort(function (a, b) { var sort = S.admin.state.sort, x = value(a, sort.key), y = value(b, sort.key); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ja')) * sort.direction; }).forEach(function (p) {
      var row = el('tr', { class: p.hidden ? 'is-hidden' : '' });
      var select = check('No.' + p.no + 'を選ぶ', S.admin.state.selected.has(p.pid), function (checked) { if (checked) S.admin.state.selected.add(p.pid); else S.admin.state.selected.delete(p.pid); S.admin.render(); }, true);
      select.label.addEventListener('click', function (event) { event.stopPropagation(); });
      row.appendChild(el('td', {}, [select.label]));
      row.appendChild(el('td', {}, [button('No.' + p.no, function () { detail(p.pid); }, 'secondary')]));
      row.append(el('td', { text: p.at }), el('td', {}, [badge(p.cat)]), el('td', {}, [p.urgent ? badge('至急', 'urgent') : '']), el('td', {}, [statusBadge(p.status)]), el('td', { text: p.who + (p.org ? '（' + p.org + '）' : '') }), el('td', {}, [el('div', { class: 'line-clamp', text: p.note })]), el('td', { text: p.photos.length + '件' }));
      var previews = el('div', { class: 'list-previews' });
      p.photos.slice(0, 3).forEach(function (photo) { previews.appendChild(photoThumb(photo)); });
      if (p.photos.length > 3) previews.appendChild(el('span', { class: 'list-more', text: '＋' + (p.photos.length - 3) }));
      row.cells[8].appendChild(previews);
      row.appendChild(el('td', {}, [el('span', { text: S.adminMap.located(p) ? p.lat + ', ' + p.lng : '位置なし' }), button('地図で見る', function () { S.adminMap.focus(p.pid); }, 'secondary')]));
      S.admin.hover(row, p.pid); row.addEventListener('click', function () { detail(p.pid); }); body.appendChild(row);
    });
    var columns = el('colgroup');
    ['select', 'number', 'date', 'category', 'urgent', 'status', 'person', 'comment', 'count', 'location'].forEach(function (name) { columns.appendChild(el('col', { class: 'column-' + name })); });
    table.append(columns, head, body); area.appendChild(table);
    if (!posts.length) area.appendChild(el('p', { class: 'empty-state', text: '表示する投稿はありません。' }));
  }
  function summary(posts) {
    var area = S.admin.byId('summary-panel'), view = S.admin.state.view; dom.clear(area);
    var box = el('details', { class: 'summary-sheet' }); box.open = S.admin.state.summaryOpen[view];
    function layout() {
      area.closest('.admin-layout').classList.toggle('summary-collapsed', view !== 'map' && !box.open);
    }
    box.addEventListener('toggle', function () {
      if (!area.contains(box)) return;
      S.admin.state.summaryOpen[view] = box.open; layout();
    });
    layout();
    box.appendChild(el('summary', { text: '件数と新着（' + posts.length + '投稿）' }));
    var counts = el('dl', { class: 'counts' });
    [['投稿', posts.length + '件'], ['写真・動画', posts.reduce(function (n, p) { return n + p.photos.length; }, 0) + '件'], ['至急', posts.filter(function (p) { return p.urgent; }).length + '件'], ['未確認', posts.filter(function (p) { return p.status === '未確認'; }).length + '件']].forEach(function (entry) { counts.append(el('dt', { text: entry[0] }), el('dd', { text: entry[1] })); });
    box.append(counts, el('h2', { text: '新着の投稿' }));
    var list = el('div', { class: 'stack recent-list' });
    posts.slice().sort(function (a, b) { return b.no - a.no; }).forEach(function (p) {
      var unread = S.admin.state.unread.has(S.admin.state.d + ':' + p.pid), node = button('', function () { detail(p.pid); }, 'recent-item secondary');
      node.append(photoThumb(p.photos[0]), el('span', {}, [el('strong', { text: (unread ? 'NEW ' : '') + 'No.' + p.no + ' ' + p.cat }), el('span', { class: 'line-clamp', text: p.note || 'コメントなし' }), statusBadge(p.status)]));
      if (p.urgent) node.appendChild(badge('至急', 'urgent')); S.admin.hover(node, p.pid); list.appendChild(node);
    });
    if (!posts.length) list.appendChild(el('p', { text: '投稿が届くと、ここに表示されます。' }));
    box.appendChild(list); area.appendChild(box);
  }
  function render(posts) {
    if (S.admin.hasView('tiles')) tileView(posts);
    if (S.admin.hasView('list')) listView(posts);
    if (S.admin.state.view !== 'split') summary(posts);
    else S.admin.byId('summary-panel').closest('.admin-layout').classList.remove('summary-collapsed');
  }
  function filters() {
    var box = modal('絞り込み'), f = S.admin.state.filters;
    function options(title, values, selected, key) {
      var set = el('fieldset', { class: 'filter-group' }, [el('legend', { text: title })]);
      values.forEach(function (value) { set.appendChild(check(value, selected.includes(value), function (checked) { var list = f[key]; if (checked) { if (!list.includes(value)) list.push(value); } else f[key] = list.filter(function (item) { return item !== value; }); S.admin.render(); }).label); });
      return set;
    }
    var categories = Array.from(new Set((S.admin.state.settings.categories || []).map(function (c) { return c.name; }).concat(S.admin.groups().map(function (p) { return p.cat; }))));
    box.body.append(options('区分（複数選べます）', categories, f.categories, 'categories'), options('状況（複数選べます）', statuses, f.statuses, 'statuses'));
    box.body.appendChild(check('至急だけ', f.urgent, function (checked) { f.urgent = checked; S.admin.render(); }).label);
    [['期間（から）', 'from', 'datetime-local'], ['期間（まで）', 'to', 'datetime-local'], ['投稿者・所属の文字', 'person', 'search'], ['キーワード（コメント・対応メモ）', 'keyword', 'search']].forEach(function (spec) {
      var input = el('input', { type: spec[2], value: f[spec[1]] });
      input.addEventListener('input', function () { f[spec[1]] = input.value; S.admin.render(); }); box.body.appendChild(field(spec[0], input));
    });
    box.body.appendChild(check('非表示を含める', f.hidden, function (checked) { f.hidden = checked; S.admin.render(); }).label);
    box.body.appendChild(el('div', { class: 'row' }, [button('条件をすべて解除', function () { Object.assign(f, { categories: [], statuses: [], urgent: false, from: '', to: '', person: '', keyword: '', hidden: false }); S.admin.render(); filters(); }, 'secondary'), button('この条件で表示する', close)]));
  }
  function detail(pid, photoId) {
    var d = S.admin.state.d, post = S.admin.groups().find(function (p) { return p.pid === pid; }); if (!post) return;
    S.admin.markOpened(pid);
    var miniMap, mediaHandle, player;
    function releaseMedia() {
      if (player) { player.pause(); player.removeAttribute('src'); player.load(); player = null; }
      if (mediaHandle) { mediaHandle.release(); mediaHandle = null; }
    }
    var box = modal('No.' + post.no + ' の詳細', function () { photoSerial++; releaseMedia(); if (miniMap) { miniMap.remove(); miniMap = null; } });
    box.resize = function () { root.requestAnimationFrame(function () { if (!box.closed && miniMap) miniMap.invalidateSize({ animate: false }); }); };
    var index = Math.max(0, post.photos.findIndex(function (p) { return p.id === photoId; })), photoSerial = 0;
    async function showPhoto() {
      var requestNumber = ++photoSerial, photo = post.photos[index];
      removeOne.textContent = photo.kind === 'video' ? 'この動画を削除' : 'この写真を削除';
      releaseMedia();
      dom.clear(photoArea);
      var thumbnail = S.admin.cache(d).thumbs.get(photo.id);
      if (thumbnail) photoArea.appendChild(el('img', { src: 'data:image/jpeg;base64,' + thumbnail, alt: 'No.' + post.no + '-' + photo.n + 'のプレビュー', class: 'detail-photo detail-preview' }));
      var status = el('p', { class: 'detail-loading', text: photo.kind === 'video' ? '動画を読み込み中…' : '高画質を読み込み中…', role: 'status' });
      var progress = el('progress', { max: '1', value: '0', class: 'detail-progress', 'aria-label': '動画の読み込み', hidden: photo.kind !== 'video' });
      photoArea.append(status, progress);
      photoCount.textContent = (index + 1) + ' / ' + post.photos.length + '件'; shot.textContent = '撮影日時：' + (photo.shot || '記録なし'); previous.disabled = index <= 0; next.disabled = index >= post.photos.length - 1;
      previous.dataset.keepDisabled = String(previous.disabled); next.dataset.keepDisabled = String(next.disabled);
      try {
        mediaHandle = S.mediaCache.acquire(d, photo, 0, function (value) {
          if (box.closed || requestNumber !== photoSerial) return;
          status.textContent = value.text; progress.hidden = false; progress.max = value.total; progress.value = value.loaded;
        });
        var entry = await mediaHandle.promise;
        if (box.closed || requestNumber !== photoSerial) return;
        if (entry.kind === 'video') {
          photo.kind = 'video'; removeOne.textContent = 'この動画を削除';
          player = el('video', { controls: '', playsinline: '', preload: 'metadata', src: entry.url, class: 'detail-video', 'aria-label': 'No.' + post.no + '-' + photo.n + 'の動画' });
          player.addEventListener('error', function () { if (!box.closed && requestNumber === photoSerial) dom.toast('このブラウザで再生できません。Googleドライブで開いてください。'); });
          dom.clear(photoArea); photoArea.appendChild(player); player.load();
        } else {
          var image = el('img', { src: entry.url, alt: 'No.' + post.no + '-' + photo.n + 'の写真', class: 'detail-photo' });
          if (image.decode) await image.decode();
          if (box.closed || requestNumber !== photoSerial) return;
          dom.clear(photoArea); photoArea.appendChild(image);
        }
        post.photos.forEach(function (other) { if (other.id !== photo.id) S.admin.prefetchItem(other, 1, d); });
      } catch (e) {
        if (box.closed || requestNumber !== photoSerial) return;
        dom.clear(photoArea); photoArea.append(el('p', { class: 'error', text: S.util.userMessage(e, '写真・動画を読み込めませんでした。もう一度お試しください。') }), button('読み直す', showPhoto, 'secondary'));
      }
    }
    var photoArea = el('div', { class: 'detail-photo-area' }), photoCount = el('strong'), shot = el('p');
    var previous = button('前へ', function () { if (index > 0) index--; return showPhoto(); }, 'secondary');
    var next = button('次へ', function () { if (index < post.photos.length - 1) index++; return showPhoto(); }, 'secondary');
    var driveLink = el('a', { target: '_blank', rel: 'noopener', text: 'Googleドライブで開く' });
    // ナビゲーションのたびに表示中のファイルへリンクを合わせる。
    function updateDrive() {
      var photo = post.photos[index]; driveLink.hidden = !photo.fileId;
      if (photo.fileId) driveLink.href = 'https://drive.google.com/file/d/' + encodeURIComponent(photo.fileId) + '/view'; else driveLink.removeAttribute('href');
    }
    var mediaColumn = el('div', { class: 'detail-media stack' }, [photoArea, el('div', { class: 'row photo-navigation' }, [previous, photoCount, next]), driveLink, shot]);
    var mapColumn = el('div', { class: 'detail-location stack' });
    box.body.appendChild(el('div', { class: 'detail-overview' }, [mediaColumn, mapColumn]));
    if (S.adminMap.located(post)) {
      var mapElement = el('div', { class: 'detail-map', 'aria-label': '投稿の場所の地図' }); mapColumn.appendChild(mapElement);
      miniMap = root.L.map(mapElement, { zoomAnimation: false, fadeAnimation: false, minZoom: 9, maxZoom: 19 }).setView([post.lat, post.lng], 17, { animate: false });
      root.L.tileLayer(root.SPM_CONFIG.tiles.osm, { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(miniMap);
      root.L.circleMarker([post.lat, post.lng], { radius: 9, color: S.adminMap.color(post.cat), fillColor: S.adminMap.color(post.cat), fillOpacity: 1, weight: 3 }).addTo(miniMap);
      root.requestAnimationFrame(function () { if (!box.closed && miniMap) miniMap.invalidateSize({ animate: false }); });
      mapColumn.append(button('大きな地図で見る', function () { close(); S.adminMap.focus(pid); }, 'secondary'), el('a', { href: S.exporter.googleMapsUrl(post.lat, post.lng), target: '_blank', rel: 'noopener', text: 'Googleマップで開く' }));
    } else mapColumn.appendChild(el('p', { text: '位置なし（「地図を押して置く」で置けます）' }));
    var info = el('dl', { class: 'detail-info' });
    [['受付日時', post.at], ['区分', post.cat], ['至急', post.urgent ? '至急' : 'なし'], ['投稿者', post.who || '未記入'], ['所属', post.org || '未記入'], ['コメント', post.note || '未記入'], ['位置', S.adminMap.located(post) ? post.lat + ', ' + post.lng : '位置なし'], ['位置の取り方', sources[post.src] || post.src], ['精度', typeof post.acc === 'number' ? '±' + post.acc + 'm' : '記録なし']].forEach(function (entry) { info.append(el('dt', { text: entry[0] }), el('dd', { text: entry[1] })); });
    box.body.appendChild(info);
    async function patch(value, redraw) { if (await S.admin.update(pid, value, d)) { if (!box.closed && redraw) detail(pid, post.photos[index].id); return true; } return false; }
    var statusControls = el('div', { class: 'row', role: 'group', 'aria-label': '状況を変更' });
    statuses.forEach(function (status, i) { var node = button(status, function () { return patch({ status: status }, true); }, 'status-button secondary ' + statusClasses[i]); node.setAttribute('aria-pressed', String(post.status === status)); statusControls.appendChild(node); });
    box.body.append(el('h3', { text: '状況' }), statusControls);
    var memo = el('textarea', { maxlength: '1000', rows: '4' }); memo.value = post.memo || '';
    box.body.append(field('対応メモ（1000字まで）', memo), button('対応メモを保存', function () { return patch({ memo: memo.value }, false); }));
    var category = el('select');
    (S.admin.state.settings.categories || []).forEach(function (c) { category.appendChild(el('option', { value: c.name, text: c.name })); });
    if (!Array.from(category.options).some(function (option) { return option.value === post.cat; })) category.appendChild(el('option', { value: post.cat, text: post.cat }));
    category.value = post.cat;
    var urgent = check('至急（人命・通行止めなど）', post.urgent);
    box.body.append(field('区分を変更', category), urgent.label, button('区分・至急を保存', function () { return patch({ cat: category.value, urgent: urgent.input.checked }, true); }));
    box.body.appendChild(button(S.adminMap.located(post) ? '位置を直す' : '地図を押して置く', function () { S.adminMap.startEdit(post, !S.adminMap.located(post)); }, 'secondary'));
    box.body.appendChild(button(post.hidden ? '表示に戻す' : '非表示にする', function () {
      confirm('No.' + post.no + 'を' + (post.hidden ? '表示に戻しますか？' : '非表示にしますか？ 写真と記録は残ります。'), async function () { if (await S.admin.update(pid, { hidden: !post.hidden }, d)) { close(); } });
    }, 'secondary'));
    function reopen() {
      var remaining = S.admin.groups().find(function (p) { return p.pid === pid; });
      if (remaining) detail(pid, remaining.photos[Math.min(index, remaining.photos.length - 1)].id);
    }
    var removeOne = button('この写真を削除', function () {
      var photo = post.photos[index];
      confirmRemove([photo], d, reopen, function () { detail(pid, photo.id); });
    }, 'danger');
    box.body.appendChild(el('div', { class: 'detail-remove-tools stack' }, [removeOne, button('この投稿をまるごと削除（写真・動画 ' + post.photos.length + '件）', function () { confirmRemove(post.photos, d, null, function () { detail(pid, post.photos[index].id); }); }, 'danger')]));
    box.refreshDetail = function () {
      var current = S.admin.groups().find(function (p) { return p.pid === pid; });
      if (!current) { close(); return; }
      if (current.photos.map(function (p) { return p.id; }).join(',') !== post.photos.map(function (p) { return p.id; }).join(',')) {
        var photo = post.photos[index];
        detail(pid, current.photos.some(function (p) { return p.id === photo.id; }) ? photo.id : current.photos[Math.min(index, current.photos.length - 1)].id);
      }
    };
    updateDrive();
    previous.addEventListener('click', updateDrive); next.addEventListener('click', updateDrive);
    showPhoto();
  }
  function folderLinks(settings) {
    var row = el('div', { class: 'row' });
    [['写真のフォルダを開く（Googleドライブ）', settings.rootFolderUrl], ['受付中の災害の写真フォルダ', settings.currentFolderUrl]].forEach(function (entry) {
      if (/^https:\/\/drive\.google\.com\//.test(entry[1] || '')) row.appendChild(el('a', { href: entry[1], target: '_blank', rel: 'noopener', text: entry[0] }));
    }); return row;
  }
  function settings() {
    var box = modal('設定'), cfg = S.admin.state.settings, current = cfg.current, chosen = S.admin.currentDisaster();
    var acceptance = el('p'), currentInfo = el('p'); box.body.append(acceptance, currentInfo);
    async function config(payload) { var result = await S.admin.configure(payload); if (result && S.admin.state.token) settings(); return result; }
    function confirmConfig(text, payload) { confirm(text, function () { return config(payload); }); }
    box.body.appendChild(button('受付を止める（合言葉も変える・おすすめ）', function () { confirmConfig('受付を止め、合言葉と投稿用リンク・QRを新しくします。よろしいですか？', { op: 'stop', changeCode: true }); }, 'danger'));
    box.body.appendChild(button('受付を止める（合言葉はそのまま）', function () { confirmConfig('合言葉を変えずに受付を止めますか？', { op: 'stop', changeCode: false }); }, 'secondary'));
    var resume = button('受付を再開する', function () { confirmConfig('同じ災害で投稿の受付を再開しますか？', { op: 'resume' }); }); resume.disabled = !current || cfg.accepting; box.body.appendChild(resume);
    function start(kind) {
      var startBox = modal(kind === '訓練' ? '訓練を始める' : '新しい災害を始める'), name = el('input', { type: 'text', maxlength: '40' });
      startBox.body.append(field('災害・訓練の名前（1〜40字）', name), el('p', { text: '前の災害は終了になります。写真と記録は残ります。合言葉と投稿用リンク・QRは変わります。' }), button('この名前で始める', function () {
        var text = name.value.trim(); if (!text || Array.from(text).length > 40) { dom.toast('1〜40字の名前を入れてください。'); name.focus(); return; }
        confirmConfig('「' + text + '」の' + kind + 'を始めますか？ 前の災害は終了になり、写真と記録は残ります。', { op: 'start', kind: kind, name: text });
      })); name.focus();
    }
    box.body.appendChild(el('div', { class: 'row' }, [button('新しい災害を始める', function () { start('災害'); }), button('訓練を始める', function () { start('訓練'); })]));
    var secret = el('div', { hidden: true, class: 'panel' }, [el('p', { class: 'secret-code', text: cfg.postCode ? S.util.formatCode(cfg.postCode) : '確認するにはパスワードでログインし直してください。' }), el('p', { text: cfg.postCode ? S.util.readCode(cfg.postCode) : '' })]);
    var reveal = button('表示する', function () { secret.hidden = !secret.hidden; reveal.textContent = secret.hidden ? '表示する' : '隠す'; reveal.setAttribute('aria-expanded', String(!secret.hidden)); }, 'secondary'); reveal.setAttribute('aria-expanded', 'false');
    box.body.append(el('h3', { text: '投稿の合言葉' }), reveal, secret, button('自動で新しくする', function () { confirmConfig('投稿の合言葉を新しくしますか？ 投稿用のリンクとQRを配り直してください。', { op: 'code' }); }, 'secondary'));
    var code = el('input', { type: 'text', maxlength: '64', autocomplete: 'off' });
    box.body.append(field('自分で決める（英数字4〜32文字。全角で入れても大丈夫です）', code), button('入力した合言葉にする', function () {
      var normalized = S.util.normCode(code.value);
      if (!/^[a-z0-9]{4,32}$/.test(normalized)) { dom.toast('合言葉は4〜32文字の英数字で入れてください。'); return; }
      confirmConfig('入力した合言葉に変えますか？ 投稿用のリンクとQRを配り直してください。', { op: 'code', code: normalized });
    }, 'secondary'));
    var shareHost = el('div'); box.body.appendChild(shareHost);
    var pageUrl = el('input', { type: 'url', maxlength: '300', value: cfg.postPageUrl || '', placeholder: 'https://…/index.html' });
    box.body.append(field('投稿ページのURL（リンク先のアドレス。PCのフォルダから開いた場合も共有できます）', pageUrl), button('投稿ページのURLを保存', function () {
      try { var url = new root.URL(pageUrl.value.trim()); if (url.protocol !== 'https:' || url.href.length > 300 || url.username || url.password) throw new Error(); url.hash = ''; return config({ op: 'postPageUrl', url: url.href }); }
      catch (e) { dom.toast('https://で始まる投稿ページのリンクを300字以内で入れてください。'); }
    }, 'secondary'));
    if (chosen) {
      var rename = el('input', { type: 'text', maxlength: '40', value: chosen.name });
      box.body.append(field('表示中の災害名を直す', rename), button('災害名を保存', function () { var name = rename.value.trim(); if (!name) { dom.toast('災害名を入れてください。'); return; } return config({ op: 'rename', d: chosen.id, name: name }); }, 'secondary'));
    }
    box.body.appendChild(button('いまの地図の表示を初期位置にする', function () { confirmConfig('いまの地図の中心と拡大を初期位置にしますか？ 拡大19の場合は18で保存します。', Object.assign({ op: 'mapHome' }, S.adminMap.home())); }, 'secondary'));
    var lock = (cfg.locks || {}).post || {};
    box.body.append(el('p', { text: '投稿の確認失敗：' + (lock.recentFailures || 0) + '回' + (lock.until > Date.now() ? '・一時ロック中' : '') }), button('投稿のロックを解除する', function () { return config({ op: 'unlock' }); }, 'secondary'));
    var sound = el('select', { id: 'new-sound' });
    [['off', '鳴らさない'], ['1', '短く1回（ピッ）'], ['2', '短く2回（ピピッ）'], ['3', '高く3回（ピピピ）'], ['4', '低→高（ピポッ）'], ['5', '長く1回（ピー）']].forEach(function (option) { sound.appendChild(el('option', { value: option[0], text: option[1] })); });
    sound.value = S.admin.state.sound;
    sound.addEventListener('change', function () { S.admin.enableSound(sound.value); });
    box.body.append(field('新着の音', sound), button('試しに鳴らす', function () { S.admin.testSound(); }, 'secondary'));
    box.body.appendChild(check('写真を先読みする（通信量が増えます）', S.admin.state.prefetch, function (checked) { S.admin.enablePrefetch(checked); }).label);
    box.body.append(folderLinks(cfg), el('small', { text: 'ページ ' + root.SPM_CONFIG.pageVersion + '／GAS ' + S.admin.state.version }), el('small', { text: '受付の接続先：' + (cfg.webAppUrl || '未取得') }), el('p', { text: '管理画面のパスワードは、スプレッドシートのメニュー⑤で変えてください。' }));
    var shareKey;
    box.refreshSettings = function () {
      cfg = S.admin.state.settings; current = cfg.current;
      acceptance.textContent = '受付：' + (cfg.accepting ? '受付中' : '停止中');
      currentInfo.textContent = current ? current.name + '（' + current.kind + '）開始：' + current.start : '受付中の災害はありません。';
      resume.disabled = !current || cfg.accepting;
      secret.firstChild.textContent = cfg.postCode ? S.util.formatCode(cfg.postCode) : '合言葉を取得できませんでした。全部読み直してください。';
      secret.lastChild.textContent = cfg.postCode ? S.util.readCode(cfg.postCode) : '';
      var nextKey = JSON.stringify([cfg.postPageUrl, cfg.postCode]);
      if (nextKey !== shareKey) { dom.clear(shareHost); if (cfg.postPageUrl) shareHost.appendChild(S.share.createPanel(cfg.postPageUrl, cfg.postCode)); shareKey = nextKey; }
    };
    box.refreshSettings();
  }
  function refreshSettings() { if (active && active.refreshSettings) active.refreshSettings(); }
  function refreshDetail() { if (active && active.refreshDetail) active.refreshDetail(); }
  function stamp(date) { var text = S.util.formatJst(date); return text.slice(0, 10).replace(/\//g, '') + '-' + text.slice(11, 16).replace(':', ''); }
  function exportName(extension, disaster) { return S.util.safeFileName('災害写真_' + (disaster ? disaster.name : '記録') + '_' + stamp(new Date()), 150) + '.' + extension; }
  function exportsDialog() {
    var posts = S.admin.targets(), d = S.admin.state.d, disaster = S.admin.currentDisaster(), box = modal('出力');
    box.body.appendChild(el('p', { text: '対象：' + (S.admin.state.selected.size ? 'チェックした' : '今の絞り込みの') + posts.length + '投稿・' + posts.reduce(function (n, p) { return n + p.photos.length; }, 0) + '枚' }));
    var formats = [['CSV（Excel用）', 'csv', 'text/csv;charset=utf-8', function () { return S.exporter.toCsv(posts); }], ['GeoJSON（地図ソフト用）', 'geojson', 'application/geo+json', function () { return JSON.stringify(S.exporter.toGeoJson(posts), null, 2); }], ['KML（Googleマイマップ・Google Earth用）', 'kml', 'application/vnd.google-earth.kml+xml', function () { return S.exporter.toKml(posts, S.admin.state.settings.categories); }]];
    formats.forEach(function (spec) { var node = button(spec[0], function () { S.share.download(new Blob([spec[3]()], { type: spec[2] }), exportName(spec[1], disaster)); }); node.disabled = !posts.length; box.body.appendChild(node); });
    box.body.appendChild(el('p', { text: 'GeoJSON・KMLは位置がある投稿だけを出力します。位置なしの投稿はCSVとZIPに含まれます。' }));
    var videos = check('動画も入れる（時間がかかります）', false);
    var zip = button('写真をまとめて保存（ZIP）', function () { return downloadZip(posts, d, disaster, videos.input.checked); }); zip.disabled = !posts.length;
    box.body.append(videos.label, zip, folderLinks(S.admin.state.settings));
  }
  async function downloadZip(posts, d, disaster, includeVideos) {
    var cancelled = false, box = modal('写真をまとめて保存', function () { cancelled = true; }), progress = el('progress', { max: '1', value: '0' }), message = el('p', { role: 'status', 'aria-live': 'polite' });
    box.body.append(message, progress, button('やめる', close, 'secondary'));
    var photos = []; posts.forEach(function (p) { p.photos.forEach(function (photo) { if (photo.kind !== 'video' || includeVideos) photos.push(photo); }); });
    progress.max = photos.length;
    var entries = [{ name: '一覧.csv', data: new TextEncoder().encode(S.exporter.toCsv(posts)), date: new Date() }];
    try {
      for (var i = 0; i < photos.length; i++) {
        if (cancelled) return;
        message.textContent = '写真・動画を取得中… ' + i + ' / ' + photos.length + '件';
        var p = photos[i], data, extension = '.jpg';
        if (p.kind === 'video') {
          var blob = await S.share.loadMedia(d, p.id, function (value) { message.textContent = value.text; }, function () { return cancelled; });
          if (!blob || cancelled) return;
          extension = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/3gpp': '.3gp', 'video/x-m4v': '.m4v' }[blob.type];
          if (!extension) throw new Error('動画の形式を確認できませんでした。');
          data = new Uint8Array(await blob.arrayBuffer());
        } else { var photo = await S.admin.photo(p.id, d); data = new Uint8Array(await photo.blob.arrayBuffer()); }
        if (cancelled) return;
        var date = p.shot || p.at, filename = S.util.safeFileName('No' + String(p.no).padStart(4, '0') + '-' + p.n + '_' + stamp(date.replace(/\//g, '-').replace(' ', 'T') + '+09:00') + '_' + p.cat, 76) + extension;
        entries.push({ name: (p.kind === 'video' ? '動画/' : '写真/') + filename, data: data, date: new Date(date.replace(/\//g, '-').replace(' ', 'T') + '+09:00') }); progress.value = i + 1;
      }
      if (cancelled) return;
      message.textContent = 'ZIPを作成しています…';
      await new Promise(function (resolve) { root.setTimeout(resolve, 0); }); if (cancelled) return;
      var archive = S.zip.makeZip(entries); if (cancelled) return;
      S.share.download(new Blob([archive], { type: 'application/zip' }), exportName('zip', disaster)); message.textContent = photos.length + '件のZIPを保存しました。';
    } catch (e) { if (!cancelled) { message.textContent = S.util.userMessage(e, '保存できませんでした。もう一度出力からやり直してください。'); message.className = 'error'; } }
  }
  async function decodeImage(src, alt) {
    var image = el('img', { alt: alt });
    if (image.decode) { image.src = src; await image.decode(); }
    else await new Promise(function (resolve, reject) { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', function () { reject(new Error('写真を表示できませんでした。')); }, { once: true }); image.src = src; });
    return image;
  }
  async function printMode() {
    var posts = S.admin.targets(), d = S.admin.state.d, disaster = S.admin.currentDisaster();
    if (!posts.length) { dom.toast('印刷する投稿がありません。'); return; }
    var cancelled = false, box = modal('印刷用の写真を準備中', function () { cancelled = true; }), total = posts.reduce(function (n, p) { return n + Math.min(4, p.photos.length); }, 0), done = 0;
    var message = el('p', { role: 'status', 'aria-live': 'polite' }), progress = el('progress', { max: total, value: '0' });
    box.body.append(message, progress, button('やめる', close, 'secondary'));
    var pages = el('div'), page;
    try {
      for (var i = 0; i < posts.length; i++) {
        if (cancelled) return;
        if (i % 2 === 0) {
          page = el('section', { class: 'print-page' });
          page.append(el('header', { class: 'print-page-heading' }, [el('h1', { text: disaster ? disaster.name : '災害写真マップ' }), el('p', { text: '印刷日時：' + S.util.formatJst(new Date()) + ' ／ ' + (Math.floor(i / 2) + 1) + ' / ' + Math.ceil(posts.length / 2) + 'ページ' })])); pages.appendChild(page);
        }
        var p = posts[i], article = el('article', { class: 'print-post' }), images = el('div', { class: 'print-photos photo-number-' + Math.min(4, p.photos.length) });
        article.appendChild(el('h2', { text: 'No.' + p.no + ' ' + p.cat + (p.urgent ? ' 【至急】' : '') + ' ／ ' + p.status + ' ／ ' + p.at }));
        for (var n = 0; n < Math.min(4, p.photos.length); n++) {
          message.textContent = '写真を取得中… ' + done + ' / ' + total + '枚';
          var item = p.photos[n], b64 = '', imageUrl = '', imageHandle = null, image;
          try {
            if (item.kind === 'video') b64 = S.admin.cache(d).thumbs.get(item.id);
            else { imageHandle = S.mediaCache.acquire(d, item, 0); var reply = await imageHandle.promise; imageUrl = reply.url; }
            if (cancelled) return;
            image = imageUrl || b64 ? await decodeImage(imageUrl || 'data:image/jpeg;base64,' + b64, 'No.' + p.no + '-' + item.n) : el('span', { class: 'thumb-empty', text: '動画' });
          } finally { if (imageHandle) imageHandle.release(); }
          if (cancelled) return;
          if (item.kind === 'video') images.appendChild(el('figure', { class: 'print-video' }, [image, el('figcaption', { text: '動画' + (S.video.formatDuration(item.duration) ? ' ' + S.video.formatDuration(item.duration) : '') })]));
          else images.appendChild(image);
          done++; progress.value = done;
        }
        var info = el('div', { class: 'print-information' }), text = el('div');
        [['場所', S.adminMap.located(p) ? p.lat + ', ' + p.lng : '位置なし'], ['投稿者・所属', p.who + (p.org ? '（' + p.org + '）' : '')], ['コメント', p.note || 'なし'], ['対応メモ', p.memo || 'なし']].forEach(function (entry) { text.appendChild(el('p', {}, [el('strong', { text: entry[0] + '：' }), entry[1]])); });
        info.appendChild(text);
        if (S.adminMap.located(p)) {
          var qr = el('canvas'); S.share.drawQr(qr, S.exporter.googleMapsUrl(p.lat, p.lng), 120);
          info.appendChild(el('div', { class: 'print-qr' }, [qr, el('small', { text: 'Googleマップ' })]));
        }
        article.append(images, info, el('div', { class: 'field-memo', text: '現地確認メモ：' })); page.appendChild(article);
      }
      if (cancelled) return;
      var area = S.admin.byId('print-pages'); dom.clear(area); while (pages.firstChild) area.appendChild(pages.firstChild);
      close(); S.admin.byId('admin-app').hidden = true; S.admin.byId('print-mode').hidden = false; root.document.body.classList.remove('admin-active');
      // 全画像のdecode完了後、印刷用の配置を反映してから印刷する。
      root.requestAnimationFrame(function () { root.requestAnimationFrame(function () { if (!S.admin.byId('print-mode').hidden && S.admin.state.token) root.print(); }); });
    } catch (e) { if (!cancelled) { message.textContent = S.util.userMessage(e, '印刷の準備ができませんでした。もう一度お試しください。'); message.className = 'error'; } }
  }
  function init() {
    S.admin.byId('filter-button').addEventListener('click', filters);
    S.admin.byId('settings-button').addEventListener('click', settings);
    S.admin.byId('export-button').addEventListener('click', exportsDialog);
    S.admin.byId('print-button').addEventListener('click', printMode);
    S.admin.byId('print-now').addEventListener('click', function () { root.print(); });
    S.admin.byId('print-back').addEventListener('click', function () { S.admin.byId('print-mode').hidden = true; dom.clear(S.admin.byId('print-pages')); S.admin.byId('admin-app').hidden = false; root.document.body.classList.add('admin-active'); S.adminMap.resize(); });
  }
  S.adminViews = { init: init, render: render, button: button, modal: modal, close: close, resizeDetail: resizeDetail, confirm: confirm, detail: detail, settings: settings, refreshSettings: refreshSettings, refreshDetail: refreshDetail, filters: filters, printMode: printMode };
})(typeof window !== 'undefined' ? window : globalThis);
