(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var S = root.SPM, dom = S.dom, el = dom.el, map, cluster, markers = new Map(), shown = new Map(), needsView = true, edit = null, pendingRipples = new Set();
  function located(p) { return typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lng === 'number' && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180; }
  function color(cat) {
    var category = (S.admin.state.settings.categories || []).find(function (c) { return c.name === cat; });
    return category && /^#[0-9a-f]{6}$/i.test(category.color) ? category.color : '#6b7280';
  }
  function thumb(p) { return S.admin.cache().thumbs.get(p.photos[0].id) || ''; }
  function note(p, bundle) {
    var card = el('div', { class: (bundle ? 'bundle-card' : 'sticky-card') + (p.urgent ? ' is-urgent' : '') + (p.hidden ? ' is-hidden' : '') + (p.status === '対応済' ? ' is-done' : '') });
    var category = el('div', { class: 'sticky-category', text: p.cat }); category.style.borderTopColor = color(p.cat); card.appendChild(category);
    var b64 = thumb(p);
    if (b64) card.appendChild(el('img', { src: 'data:image/jpeg;base64,' + b64, alt: 'No.' + p.no + 'の写真', draggable: 'false' }));
    else card.appendChild(el('span', { class: 'thumb-empty', text: '写真' }));
    if (p.photos[0].kind === 'video') card.appendChild(el('span', { class: 'media-label', text: '▶ ' + (S.video.formatDuration(p.photos[0].duration) || '動画') }));
    if (!bundle) {
      card.appendChild(el('span', { class: 'photo-count', text: p.photos.length > 1 ? p.photos.length + '枚' : 'No.' + p.no }));
      if (p.urgent) card.appendChild(el('span', { class: 'urgent-label', text: '至急' }));
      if (S.admin.state.unread.has(S.admin.state.d + ':' + p.pid)) card.appendChild(el('span', { class: 'new-label', text: 'NEW' }));
    }
    return card;
  }
  function icon(p) { return root.L.divIcon({ html: note(p, false), className: 'sticky-marker', iconSize: [76, 92], iconAnchor: [38, 102] }); }
  function updateMarkerOrder(marker) {
    var post = shown.get(marker.spmPid);
    marker.setZIndexOffset(edit && edit.pid === marker.spmPid ? 2000 : marker.spmHovered || marker.spmFocused ? 1000 : post && post.urgent ? 500 : 0);
  }
  function markerFocus(event) { this.spmFocused = event.type === 'focus'; updateMarkerOrder(this); }
  function bindMarkerFocus(marker) {
    var element = marker.getElement();
    if (!element) return;
    root.L.DomEvent.off(element, 'focus blur', markerFocus, marker);
    root.L.DomEvent.on(element, 'focus blur', markerFocus, marker);
    marker.spmFocused = root.document.activeElement === element;
  }
  function clusterIcon(group) {
    var children = group.getAllChildMarkers(), posts = children.map(function (m) { return shown.get(m.spmPid); }).filter(Boolean);
    posts.sort(function (a, b) { return b.no - a.no; });
    var wrapper = el('div', { class: 'sticky-bundle', 'aria-label': children.length + '投稿のまとまり' });
    if (posts.length) wrapper.appendChild(note(posts[0], true));
    wrapper.appendChild(el('span', { class: 'bundle-count', text: children.length + '件' }));
    if (posts.some(function (p) { return p.urgent; })) wrapper.appendChild(el('span', { class: 'bundle-urgent', text: '● 至急あり' }));
    return root.L.divIcon({ html: wrapper, className: 'bundle-marker', iconSize: [100, 112], iconAnchor: [50, 56] });
  }
  function init() {
    if (map) return;
    map = S.mapbase.createMap(S.admin.byId('admin-map'), Object.assign({}, S.admin.state.settings.map || root.SPM_CONFIG.defaultMap));
    cluster = root.L.markerClusterGroup({ iconCreateFunction: clusterIcon, maxClusterRadius: 90, spiderfyOnMaxZoom: true, spiderfyDistanceMultiplier: 4, showCoverageOnHover: false, animate: !root.matchMedia('(prefers-reduced-motion: reduce)').matches });
    cluster.addTo(map);
    addMissingControl();
    map.on('click', function (event) { if (edit && edit.placing && !edit.saving) placeAt(event.latlng); });
    cluster.on('clusterclick', function (event) { if (edit && edit.placing && !edit.saving) placeAt(event.latlng); });
    cluster.on('animationend spiderfied', flushRipples);
    // 展開・収納時に部品が上書きした重なり順を、付箋の優先順位に戻す。
    cluster.on('spiderfied unspiderfied', function () { markers.forEach(updateMarkerOrder); });
    map.on('moveend', flushRipples);
  }
  function render(posts) {
    if (!map) return;
    shown = new Map(posts.map(function (p) { return [p.pid, p]; }));
    pendingRipples.forEach(function (pid) { if (!shown.has(pid)) pendingRipples.delete(pid); });
    if (edit && !shown.has(edit.pid)) cancelEdit();
    var wanted = new Set(posts.filter(located).map(function (p) { return p.pid; }));
    markers.forEach(function (marker, pid) { if (!wanted.has(pid) && (!edit || edit.pid !== pid)) { cluster.removeLayer(marker); markers.delete(pid); } });
    posts.filter(located).forEach(function (p) {
      if (edit && edit.pid === p.pid) return;
      var marker = markers.get(p.pid), preview = thumb(p), signature = JSON.stringify([p.lat, p.lng, p.cat, color(p.cat), p.urgent, p.hidden, p.status, p.photos.length, p.photos[0].id, p.photos[0].kind, p.photos[0].duration, S.admin.state.unread.has(S.admin.state.d + ':' + p.pid)]);
      if (!marker) {
        marker = root.L.marker([p.lat, p.lng], { icon: icon(p), title: 'No.' + p.no + ' ' + p.cat + ' ' + p.status + (p.urgent ? ' 至急' : ''), keyboard: true, zIndexOffset: p.urgent ? 500 : 0 }); marker.spmPid = p.pid;
        marker.on('mouseover mouseout', function (event) { this.spmHovered = event.type === 'mouseover'; updateMarkerOrder(this); });
        marker.on('add', function () { bindMarkerFocus(this); updateMarkerOrder(this); });
        marker.on('remove', function () { this.spmHovered = this.spmFocused = false; });
        marker.on('click', function (event) {
          if (edit && edit.placing && !edit.saving) placeAt(event.latlng);
          else if (!edit) S.adminViews.detail(p.pid);
        });
        markers.set(p.pid, marker); cluster.addLayer(marker);
      } else if (marker.spmSignature !== signature || marker.spmThumb !== preview) {
        if (!marker.getLatLng().equals([p.lat, p.lng])) marker.setLatLng([p.lat, p.lng]);
        marker.setIcon(icon(p));
        bindMarkerFocus(marker);
      }
      updateMarkerOrder(marker);
      marker.spmSignature = signature; marker.spmThumb = preview;
    });
    cluster.refreshClusters();
    var missing = posts.filter(function (p) { return !located(p); }), button = root.document.getElementById('unlocated-button');
    button.textContent = '📍 位置なし ' + missing.length + '件'; button.disabled = !missing.length;
  }
  function initialView(posts) {
    if (!map || !needsView || S.admin.byId('map-view').hidden) return;
    needsView = false;
    var home = S.admin.state.settings.map;
    if (home) map.setView([home.lat, home.lng], home.zoom);
    else {
      var points = posts.filter(located).map(function (p) { return [p.lat, p.lng]; });
      if (points.length) map.fitBounds(points, { padding: [70, 110], maxZoom: 16 });
      else { var fallback = root.SPM_CONFIG.defaultMap; map.setView([fallback.lat, fallback.lng], Math.max(9, fallback.zoom)); }
    }
  }
  function resetView() {
    needsView = true; pendingRipples.clear();
    if (cluster) cluster.clearLayers(); markers.clear(); shown.clear();
  }
  function focus(pid) {
    if (edit) { cancelEdit(); S.admin.render(); }
    S.admin.setView('map'); var marker = markers.get(pid);
    if (!marker) { S.adminViews.detail(pid); return; }
    var d = S.admin.state.d;
    cluster.zoomToShowLayer(marker, function () { if (!S.admin.state.token || S.admin.state.d !== d) return; S.adminViews.detail(pid); });
  }
  function flushRipples() {
    if (!map) return;
    pendingRipples.forEach(function (pid) { var marker = markers.get(pid); if (marker && marker.getElement()) { map.spm.rippleMarker(marker); pendingRipples.delete(pid); } });
  }
  function ripple(pids) { pids.forEach(function (pid) { pendingRipples.add(pid); }); root.setTimeout(flushRipples, 350); }
  function resize() { if (map) root.setTimeout(function () { if (map) map.invalidateSize(); }, 0); }
  function positionBar(text, canSave) {
    var bar = S.admin.byId('position-tools'); dom.clear(bar); bar.hidden = false;
    bar.appendChild(el('strong', { text: text }));
    if (canSave) {
      var save = S.adminViews.button(edit.placing ? 'この位置に置く' : 'この位置で保存', async function () {
        var active = edit; if (!active || active.saving) return;
        active.saving = true;
        var ll = active.marker.getLatLng(), ok = await S.admin.update(active.pid, { lat: ll.lat, lng: ll.lng }, active.d);
        active.saving = false;
        if (edit !== active) return;
        if (ok) { cancelEdit(); S.admin.render(); } else save.disabled = false;
      });
      bar.appendChild(save);
    }
    bar.appendChild(S.adminViews.button('やめる', function () { cancelEdit(); S.admin.render(); }, 'secondary'));
  }
  function placeAt(ll) {
    if (!edit.marker) edit.marker = root.L.marker(ll, { draggable: true, icon: root.L.divIcon({ html: el('span', { class: 'place-pin', text: '📍' }), className: 'place-marker', iconSize: [48, 48], iconAnchor: [24, 44] }) }).addTo(map);
    else edit.marker.setLatLng(ll);
    positionBar('No.' + edit.no + 'をここに置きます（' + ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) + '）。合っているか確認してください。', true);
  }
  function startEdit(p, placing) {
    cancelEdit(); S.adminViews.close(); S.admin.setView('map'); S.admin.render();
    edit = { pid: p.pid, no: p.no, d: S.admin.state.d, placing: placing, marker: null, saving: false };
    // 編集中は束を押しても拡大・展開せず、置く操作だけを受け付ける。
    cluster.options.zoomToBoundsOnClick = false; cluster.options.spiderfyOnMaxZoom = false;
    if (placing || !located(p)) { edit.placing = true; positionBar('No.' + p.no + 'を置く場所を地図で押してください。', false); }
    else {
      var marker = markers.get(p.pid); if (!marker) { cancelEdit(); return; }
      cluster.removeLayer(marker); marker.addTo(map); marker.dragging.enable(); marker.setZIndexOffset(2000); edit.marker = marker;
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17));
      positionBar('No.' + p.no + 'の付箋をドラッグして位置を直し、保存してください。', true);
    }
    root.document.getElementById('position-tools').scrollIntoView({ block: 'nearest' }); resize();
  }
  function cancelEdit() {
    if (!edit) return;
    if (edit.marker && map) { if (edit.marker.dragging) edit.marker.dragging.disable(); map.removeLayer(edit.marker); }
    if (!edit.placing) markers.delete(edit.pid);
    cluster.options.zoomToBoundsOnClick = true; cluster.options.spiderfyOnMaxZoom = true;
    edit = null; S.admin.byId('position-tools').hidden = true;
  }
  function unlocated() {
    var dialog = S.adminViews.modal('位置なしの投稿'), posts = S.admin.filtered().filter(function (p) { return !located(p); });
    posts.forEach(function (p) {
      var card = el('article', { class: 'panel stack' }, [el('strong', { text: 'No.' + p.no + ' ' + p.cat }), el('p', { text: p.note || 'コメントなし' })]);
      card.appendChild(S.adminViews.button('地図を押して置く', function () { startEdit(p, true); })); dialog.body.appendChild(card);
    });
    if (!posts.length) dialog.body.appendChild(el('p', { text: '位置なしの投稿はありません。' }));
  }
  function addMissingControl() {
    var control = root.L.control({ position: 'topleft' }), button = el('button', { id: 'unlocated-button', type: 'button', text: '📍 位置なし 0件' });
    control.onAdd = function () { var box = el('div', { class: 'missing-control' }, [button]); root.L.DomEvent.disableClickPropagation(box); root.L.DomEvent.disableScrollPropagation(box); return box; };
    control.addTo(map); button.addEventListener('click', unlocated);
  }
  function destroy() { cancelEdit(); if (map) map.remove(); map = cluster = null; markers.clear(); shown.clear(); pendingRipples.clear(); needsView = true; }
  function home() { var center = map.getCenter(); return { lat: center.lat, lng: center.lng, zoom: Math.min(18, map.getZoom()) }; }
  S.adminMap = { init: init, render: render, initialView: initialView, resetView: resetView, focus: focus, ripple: ripple, resize: resize, startEdit: startEdit, cancelEdit: cancelEdit, destroy: destroy, home: home, located: located, color: color };
})(typeof window !== 'undefined' ? window : globalThis);
