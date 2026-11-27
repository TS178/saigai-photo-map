(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var S = root.SPM, dom = S.dom, el = dom.el, normal = null, panes = [], lastPane = 0;
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
    if (p.photos[0].kind === 'video') card.appendChild(el('span', { class: 'media-label', text: '動画' + (S.video.formatDuration(p.photos[0].duration) ? ' ' + S.video.formatDuration(p.photos[0].duration) : '') }));
    if (!bundle) {
      card.appendChild(el('span', { class: 'photo-count', text: p.photos.length > 1 ? p.photos.length + '枚' : 'No.' + p.no }));
      if (p.urgent) card.appendChild(el('span', { class: 'urgent-label', text: '至急' }));
      if (S.admin.state.unread.has(S.admin.state.d + ':' + p.pid)) card.appendChild(el('span', { class: 'new-label', text: 'NEW' }));
    }
    return card;
  }
  // 地図・束・付箋・編集状態を地図ごとに持つ。
  function create(element, options) {
    options = options || {};
    var map, cluster, markers = new Map(), shown = new Map(), needsView = !options.pane, edit = null, pendingRipples = new Set(), fresh = new Set(), observer;
    var restoreView = options.pane ? Object.assign({}, options.view) : null, restoring = false, moving = false;
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
      if (!element.spmPrefetchBound) { S.admin.hover(element, marker.spmPid); element.spmPrefetchBound = true; }
      marker.spmFocused = root.document.activeElement === element;
    }
    function clusterIcon(group) {
      var children = group.getAllChildMarkers(), posts = children.map(function (m) { return shown.get(m.spmPid); }).filter(Boolean);
      posts.sort(function (a, b) { return b.no - a.no; });
      var wrapper = el('div', { class: 'sticky-bundle', 'aria-label': children.length + '投稿のまとまり' });
      if (posts.length) wrapper.appendChild(note(posts[0], true));
      wrapper.appendChild(el('span', { class: 'bundle-count', text: children.length + '件' }));
      if (posts.some(function (p) { return p.urgent; })) wrapper.appendChild(el('span', { class: 'bundle-urgent', text: '至急あり' }));
      return root.L.divIcon({ html: wrapper, className: 'bundle-marker', iconSize: [100, 112], iconAnchor: [50, 56] });
    }
    function init() {
      if (map) return;
      map = S.mapbase.createMap(element, Object.assign({}, options.view || S.admin.state.settings.map || root.SPM_CONFIG.defaultMap, options.pane ? { rememberBase: false } : {}));
      cluster = root.L.markerClusterGroup({ iconCreateFunction: clusterIcon, maxClusterRadius: 90, spiderfyOnMaxZoom: true, spiderfyDistanceMultiplier: 4, showCoverageOnHover: false, animate: !root.matchMedia('(prefers-reduced-motion: reduce)').matches });
      cluster.addTo(map);
      map.on('click', function (event) { if (edit && edit.placing && !edit.saving) placeAt(event.latlng); });
      cluster.on('clusterclick', function (event) { if (edit && edit.placing && !edit.saving) placeAt(event.latlng); });
      cluster.on('animationend spiderfied', flushRipples);
      // 展開・収納時に部品が上書きした重なり順を、付箋の優先順位に戻す。
      cluster.on('spiderfied unspiderfied', function () { markers.forEach(updateMarkerOrder); });
      map.on('moveend', flushRipples);
      // invalidateSizeはmovestartを出さない。操作による移動と種類変更だけを保存する。
      map.on('movestart', function () { moving = !restoring; });
      map.on('moveend spmbasechange', changed);
      map.on('zoomend', updateHeading);
      map.on('click dragstart', interact);
      element.addEventListener('pointerdown', interact, true);
      element.addEventListener('wheel', interact, true);
      element.addEventListener('keydown', interact, true);
      if (root.ResizeObserver) { observer = new root.ResizeObserver(resize); observer.observe(element); }
    }
    function render(posts) {
      if (!map) return;
      shown = new Map(posts.map(function (p) { return [p.pid, p]; }));
      pendingRipples.forEach(function (pid) { if (!shown.has(pid)) pendingRipples.delete(pid); });
      fresh.forEach(function (pid) { if (!shown.has(pid) || !located(shown.get(pid))) fresh.delete(pid); });
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
            else if (!edit) { interact(); S.adminViews.detail(p.pid); }
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
      cluster.refreshClusters(); updateHeading();
    }
    function initialView(posts) {
      if (!map || !needsView || options.pane || S.admin.byId('map-view').hidden) return;
      needsView = false;
      var home = S.admin.state.settings.map;
      if (home) map.setView([home.lat, home.lng], home.zoom, { animate: false });
      else {
        var points = posts.filter(located).map(function (p) { return [p.lat, p.lng]; });
        if (points.length) map.fitBounds(points, { padding: [70, 110], maxZoom: 16, animate: false });
        else { var fallback = root.SPM_CONFIG.defaultMap; map.setView([fallback.lat, fallback.lng], Math.max(9, fallback.zoom), { animate: false }); }
      }
    }
    function resetView() {
      needsView = !options.pane; pendingRipples.clear(); fresh.clear();
      if (cluster) cluster.clearLayers(); markers.clear(); shown.clear();
      updateHeading();
    }
    function focus(pid) {
      if (edit) { cancelEdit(); S.admin.render(); }
      if (!S.admin.hasView('map')) S.admin.setView('map');
      resize(); var marker = markers.get(pid);
      if (!marker) { S.adminViews.detail(pid); return; }
      var d = S.admin.state.d;
      cluster.zoomToShowLayer(marker, function () { if (!S.admin.state.token || S.admin.state.d !== d) return; S.adminViews.detail(pid); });
    }
    function flushRipples() {
      if (!map) return;
      pendingRipples.forEach(function (pid) { var marker = markers.get(pid); if (marker && marker.getElement()) { map.spm.rippleMarker(marker); pendingRipples.delete(pid); } });
    }
    function ripple(pids) {
      pids.forEach(function (pid) {
        var post = shown.get(pid);
        if (!post || !located(post)) return;
        pendingRipples.add(pid);
        if (options.pane && post && located(post) && map.getBounds().contains([post.lat, post.lng])) fresh.add(pid);
      });
      updateHeading(); root.setTimeout(flushRipples, 350);
    }
    function resize() {
      if (map) root.setTimeout(function () {
        // 非表示の枠を0pxで再計算せず、表示中は中心を保って大きさを合わせる。
        if (map && element.clientWidth !== 0 && element.clientHeight !== 0) {
          restoring = true;
          try {
            map.invalidateSize({ animate: false });
            // 全枠を配置して寸法が決まってから復元し、その丸めは保存値へ戻さない。
            if (restoreView) { map.setView([restoreView.lat, restoreView.lng], restoreView.zoom, { animate: false }); restoreView = null; }
          } finally { restoring = false; }
          updateHeading();
        }
      }, 0);
    }
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
      if (!edit.marker) edit.marker = root.L.marker(ll, { draggable: true, icon: root.L.divIcon({ html: el('span', { class: 'place-pin', text: '位置' }), className: 'place-marker', iconSize: [48, 48], iconAnchor: [24, 44] }) }).addTo(map);
      else edit.marker.setLatLng(ll);
      positionBar('No.' + edit.no + 'をここに置きます（' + ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) + '）。合っているか確認してください。', true);
    }
    function startEdit(p, placing) {
      cancelEdit(); S.adminViews.close(); if (!S.admin.hasView('map')) S.admin.setView('map'); S.admin.render();
      edit = { pid: p.pid, no: p.no, d: S.admin.state.d, placing: placing, marker: null, saving: false };
      // 編集中は束を押しても拡大・展開せず、置く操作だけを受け付ける。
      cluster.options.zoomToBoundsOnClick = false; cluster.options.spiderfyOnMaxZoom = false;
      if (placing || !located(p)) { edit.placing = true; positionBar('No.' + p.no + 'を置く場所を地図で押してください。', false); }
      else {
        var marker = markers.get(p.pid); if (!marker) { cancelEdit(); return; }
        cluster.removeLayer(marker); marker.addTo(map); marker.dragging.enable(); marker.setZIndexOffset(2000); edit.marker = marker;
        map.setView([p.lat, p.lng], Math.max(map.getZoom(), 17), { animate: false });
        positionBar('No.' + p.no + 'の付箋をドラッグして位置を直し、保存してください。', true);
      }
      if (root.innerWidth < 900) S.admin.byId('position-tools').scrollIntoView({ block: 'nearest' }); resize();
    }
    function cancelEdit() {
      if (!edit) return;
      if (edit.marker && map) { if (edit.marker.dragging) edit.marker.dragging.disable(); map.removeLayer(edit.marker); }
      if (!edit.placing) markers.delete(edit.pid);
      cluster.options.zoomToBoundsOnClick = true; cluster.options.spiderfyOnMaxZoom = true;
      edit = null; S.admin.byId('position-tools').hidden = true;
    }
    function snapshot() { var center = map.getCenter(); return { lat: center.lat, lng: center.lng, zoom: map.getZoom(), base: map.spm.getBase() }; }
    function updateHeading() {
      if (!options.pane) return;
      var count = 0, bounds = map.getBounds();
      shown.forEach(function (post) { if (located(post) && bounds.contains([post.lat, post.lng])) count++; });
      options.range.textContent = 'この範囲 ' + count + '件';
      options.notice.hidden = !fresh.size; options.notice.textContent = '新着 ' + fresh.size + '件';
    }
    function changed(event) {
      updateHeading();
      if (restoring || restoreView) return;
      var remember = event.type === 'spmbasechange' || moving;
      if (event.type === 'moveend') moving = false;
      if (remember && options.onChange) options.onChange(snapshot());
    }
    function interact() { fresh.clear(); updateHeading(); if (options.onInteract) options.onInteract(); }
    function home() { var view = S.admin.state.settings.map || root.SPM_CONFIG.defaultMap; interact(); map.setView([view.lat, view.lng], view.zoom, { animate: false }); }
    function destroy() {
      cancelEdit(); if (observer) observer.disconnect();
      element.removeEventListener('pointerdown', interact, true); element.removeEventListener('wheel', interact, true); element.removeEventListener('keydown', interact, true);
      if (map) map.remove(); map = cluster = null; markers.clear(); shown.clear(); pendingRipples.clear(); fresh.clear();
    }
    init();
    return { render: render, initialView: initialView, resetView: resetView, focus: focus, ripple: ripple, resize: resize, startEdit: startEdit, cancelEdit: cancelEdit, destroy: destroy, snapshot: snapshot, home: home, interact: interact };
  }
  function unlocated() {
    var dialog = S.adminViews.modal('位置なしの投稿'), posts = S.admin.filtered().filter(function (p) { return !located(p); });
    posts.forEach(function (p) {
      var card = el('article', { class: 'panel stack' }, [el('strong', { text: 'No.' + p.no + ' ' + p.cat }), el('p', { text: p.note || 'コメントなし' })]);
      card.appendChild(S.adminViews.button('地図を押して置く', function () { startEdit(p, true); })); dialog.body.appendChild(card);
    });
    if (!posts.length) dialog.body.appendChild(el('p', { text: '位置なしの投稿はありません。' }));
  }
  function visible() { return S.admin.state.view === 'split' ? panes.slice(0, S.admin.state.split.count).map(function (pane) { return pane.controller; }) : normal ? [normal] : []; }
  function each(action, value) { visible().forEach(function (controller) { controller[action](value); }); }
  function cancelEdit() { if (normal) normal.cancelEdit(); panes.forEach(function (pane) { pane.controller.cancelEdit(); }); }
  function current() { return S.admin.state.view === 'split' && panes.length ? panes[Math.min(lastPane, S.admin.state.split.count - 1)].controller : normal; }
  function init() { if (!normal) normal = create(S.admin.byId('admin-map')); }
  function layout() {
    if (!normal) return;
    var area = S.admin.byId('split-panes'), split = S.admin.state.split;
    if (S.admin.state.view !== 'split') return;
    var initial = normal.snapshot();
    for (var i = 0; i < split.count; i++) {
      if (!panes[i]) {
        (function (index) {
          var pane = el('section', { class: 'split-pane', 'data-pane': index, 'aria-label': '地図' + (index + 1) });
          var range = el('span', { class: 'pane-range', role: 'status' }), notice = el('button', { type: 'button', class: 'pane-new', hidden: true });
          var home = el('button', { type: 'button', class: 'secondary', text: '初期位置' });
          var element = el('div', { id: 'split-map-' + (index + 1), class: 'map split-map' });
          pane.append(el('div', { class: 'pane-heading' }, [el('strong', { text: '地図' + (index + 1) }), range, notice, home]), element); area.appendChild(pane);
          if (!split.maps[index]) split.maps[index] = Object.assign({}, initial);
          var controller = create(element, { pane: true, view: split.maps[index], range: range, notice: notice,
            onInteract: function () { lastPane = index; },
            onChange: function (view) { S.admin.state.split.maps[index] = view; S.admin.saveSplit(); }
          });
          panes[index] = { node: pane, controller: controller };
          home.addEventListener('click', controller.home); notice.addEventListener('click', controller.interact);
        })(i);
      } else area.appendChild(panes[i].node);
    }
    panes.slice(split.count).forEach(function (pane) { pane.node.remove(); });
    if (lastPane >= split.count) lastPane = 0;
    S.admin.saveSplit(); each('resize');
  }
  function startEdit(post, placing) {
    cancelEdit(); if (!S.admin.hasView('map')) S.admin.setView('map');
    var controller = current(); if (controller) controller.startEdit(post, placing);
  }
  function focus(pid) { cancelEdit(); if (!S.admin.hasView('map')) S.admin.setView('map'); var controller = current(); if (controller) controller.focus(pid); }
  function destroy() {
    if (normal) normal.destroy(); normal = null;
    panes.forEach(function (pane) { pane.controller.destroy(); }); panes = []; lastPane = 0; dom.clear(S.admin.byId('split-panes'));
  }
  function home() { var controller = current(); if (!controller) return root.SPM_CONFIG.defaultMap; var view = controller.snapshot(); return { lat: view.lat, lng: view.lng, zoom: Math.min(18, view.zoom) }; }
  S.adminMap = { init: init, layout: layout, render: function (posts) { each('render', posts); }, initialView: function (posts) { if (normal) normal.initialView(posts); },
    resetView: function () { if (normal) normal.resetView(); panes.forEach(function (pane) { pane.controller.resetView(); }); }, focus: focus,
    ripple: function (pids) { each('ripple', pids); }, resize: function () { each('resize'); }, startEdit: startEdit, cancelEdit: cancelEdit, destroy: destroy, home: home, located: located, color: color, unlocated: unlocated };
})(typeof window !== 'undefined' ? window : globalThis);
