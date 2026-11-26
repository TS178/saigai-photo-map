(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  function createMap(element, options) {
    options = options || {};
    var L = root.L, dom = root.SPM.dom, el = dom.el, config = root.SPM_CONFIG, layers = {}, current = null, opened = 0, dot, circle, removed = false;
    var map = L.map(element, { closePopupOnClick: false, zoomControl: true, minZoom: 9, maxZoom: 19 }).setView([options.lat, options.lng], Math.min(19, Math.max(9, options.zoom || 13)));
    var osmCredit = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    var gsiCredit = '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>';
    var notice = el('div', { class: 'photo-notice', text: '拡大すると航空写真になります', hidden: true });
    element.appendChild(notice);
    function makeLayer(name) {
      if (layers[name]) return layers[name];
      if (name === 'photo') layers[name] = L.layerGroup([
        L.tileLayer(config.tiles.osm, { minZoom: 9, maxZoom: 13, attribution: osmCredit }),
        L.tileLayer(config.tiles.photo, { minZoom: 14, maxNativeZoom: 18, maxZoom: 19, attribution: gsiCredit + '（全国最新写真）・GRUS画像（© Axelspace）' })
      ]);
      else if (name === 'gsiStd') layers[name] = L.tileLayer(config.tiles.gsiStd, { minZoom: 9, maxNativeZoom: 18, maxZoom: 19, attribution: gsiCredit });
      else layers[name] = L.tileLayer(config.tiles.osm, { minZoom: 9, maxZoom: 19, attribution: osmCredit });
      return layers[name];
    }
    var controls = L.control({ position: 'topleft' }), panel = el('div', { class: 'base-panel', hidden: true }), buttons = {};
    var locate = el('button', { type: 'button', class: 'map-locate', 'aria-label': '現在地を表示', text: '◎' });
    var toggle = el('button', { type: 'button', 'aria-expanded': 'false', text: '🗺️ 地図の種類' });
    var controlsElement = el('div', { class: 'map-tools' }, [locate, toggle, panel]);
    function showPanel(show) { panel.hidden = !show; toggle.setAttribute('aria-expanded', String(show)); }
    function switchBase(name) {
      if (!['osm', 'photo', 'gsiStd'].includes(name)) name = 'osm';
      if (current) map.removeLayer(makeLayer(current));
      current = name; var layer = makeLayer(name); layer.addTo(map);
      if (layer.bringToBack) layer.bringToBack(); else layer.eachLayer(function (l) { l.bringToBack(); });
      notice.hidden = !(name === 'photo' && map.getZoom() < 14);
      Object.keys(buttons).forEach(function (key) { buttons[key].textContent = (key === name ? '✓ ' : '') + buttons[key].dataset.label; buttons[key].setAttribute('aria-pressed', String(key === name)); });
      try { root.localStorage.setItem('spm-base', name); } catch (e) { /* 保存なしでも地図は使える。 */ }
      showPanel(false);
    }
    [['osm', '標準地図'], ['photo', '航空写真'], ['gsiStd', '地理院地図（予備）']].forEach(function (item) {
      var button = el('button', { type: 'button', 'data-label': item[1], text: item[1] });
      buttons[item[0]] = button; button.addEventListener('click', function () { switchBase(item[0]); }); panel.appendChild(button);
    });
    controls.onAdd = function () { L.DomEvent.disableClickPropagation(controlsElement); L.DomEvent.disableScrollPropagation(controlsElement); return controlsElement; }; controls.addTo(map);
    toggle.addEventListener('click', function () { showPanel(panel.hidden); });
    function setCurrent(point, center) {
      var ll = [point.lat, point.lng];
      if (!dot) {
        dot = L.marker(ll, { icon: L.divIcon({ html: el('span', { class: 'me-dot' }), className: 'me-icon', iconSize: [20, 20], iconAnchor: [10, 10] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
        circle = L.circle(ll, { radius: point.acc || 0, stroke: false, fillColor: '#0b57d0', fillOpacity: 0.16, className: 'me-accuracy', interactive: false }).addTo(map);
      } else { dot.setLatLng(ll); circle.setLatLng(ll); circle.setRadius(point.acc || 0); }
      if (center) map.setView(ll, Math.max(map.getZoom(), 16));
    }
    locate.addEventListener('click', async function () {
      locate.disabled = true;
      try { var point = await root.SPM.geo.acquire({ maxMs: 8000, goodAcc: 30 }); if (removed) return; setCurrent(point, true); if (options.onLocate) options.onLocate(point); }
      catch (e) { dom.toast(root.SPM.geo.errorMessage(e)); }
      finally { locate.disabled = false; }
    });
    function setDetailOpen(open) { if (options.mobile) { element.classList.toggle('map-detail-open', open); if (open) showPanel(false); } }
    map.on('popupopen', function () { opened = Date.now(); setDetailOpen(true); });
    map.on('popupclose', function () { setDetailOpen(false); });
    map.on('click', function () { showPanel(false); if (Date.now() - opened >= 700) map.closePopup(); });
    map.on('zoomend', function () { notice.hidden = !(current === 'photo' && map.getZoom() < 14); });
    map.on('unload', function () { removed = true; });
    var initial = 'osm'; try { initial = root.localStorage.getItem('spm-base') || initial; } catch (e) { /* 標準地図を使う。 */ }
    switchBase(initial);
    function rippleMarker(marker) {
      var node = marker.getElement(); if (!node) return;
      var ripple = el('span', { class: 'marker-ripple', 'aria-hidden': 'true' }); node.appendChild(ripple);
      root.setTimeout(function () { ripple.remove(); }, 2800);
    }
    // Leafletの地図を返し、共通の追加操作をまとめて持たせる。
    map.spm = { switchBase: switchBase, setCurrent: setCurrent, setDetailOpen: setDetailOpen, rippleMarker: rippleMarker };
    return map;
  }
  root.SPM.mapbase = { createMap: createMap };
})(typeof window !== 'undefined' ? window : globalThis);
