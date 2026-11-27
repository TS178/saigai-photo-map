(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var sources = { gps: '現在地(GPS)', exif: '写真の位置情報', map: '地図で指定', gmap: 'Googleマップ', landmark: '目印', none: '位置なし', admin: '管理者が修正' };
  function text(value) { return value === undefined || value === null ? '' : String(value); }
  function located(p) { return typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && typeof p.lng === 'number' && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180; }
  function googleMapsUrl(lat, lng) { return located({ lat: lat, lng: lng }) ? 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng : ''; }
  function photos(p, byPost) {
    var found = byPost && (typeof byPost.get === 'function' ? byPost.get(p.pid) : byPost[p.pid]);
    return found || p.photos || p.items || [p];
  }
  function csvCell(value) {
    var s = text(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[,"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(posts, photosByPost) {
    var rows = [['受付番号', '何枚目', '受付日時', '撮影日時', '区分', '至急', '状況', '緯度', '経度', '位置の精度(m)', '位置の取り方', 'コメント', '投稿者', '所属', '対応メモ', '非表示', '写真ID', 'Googleマップ', '種類', '長さ(秒)']];
    posts.forEach(function (p) { photos(p, photosByPost).forEach(function (photo, index) {
      var r = Object.assign({}, p, photo);
      rows.push([r.no, r.n || index + 1, r.at, r.shot, r.cat, r.urgent ? '至急' : '', r.status, r.lat, r.lng, r.acc, sources[r.src] || r.src, r.note, r.who, r.org, r.memo, r.hidden ? '非表示' : '', r.id, googleMapsUrl(r.lat, r.lng), r.kind === 'video' ? '動画' : '写真', r.kind === 'video' ? r.duration : '']);
    }); });
    return '\uFEFF' + rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }
  function properties(p) {
    var list = photos(p), ids = list.map(function (r) { return r.id; }).filter(Boolean);
    return { '受付番号': p.no, '区分': p.cat, '至急': !!p.urgent, '状況': p.status || '未確認', '受付日時': p.at || '', '投稿者': p.who || '', '所属': p.org || '', 'コメント': p.note || '', '対応メモ': p.memo || '', '写真の数': list.length, '写真ID': ids,
      '種類': list.map(function (r) { return r.kind === 'video' ? '動画' : '写真'; }), '長さ(秒)': list.map(function (r) { return r.kind === 'video' ? text(r.duration) : ''; }) };
  }
  function toGeoJson(posts) {
    return { type: 'FeatureCollection', features: posts.filter(located).map(function (p) { return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: properties(p) }; }) };
  }
  function xml(value) { return text(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]; }); }
  function toKml(posts, categories) {
    var styles = {}, definitions = (categories || []).map(function (c, i) {
      styles[c.name] = 'cat' + i; var color = /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.slice(1) : '6b7280';
      return '<Style id="cat' + i + '"><IconStyle><color>ff' + color.slice(4, 6) + color.slice(2, 4) + color.slice(0, 2) + '</color></IconStyle></Style>';
    }).join('');
    var marks = posts.filter(located).map(function (p) {
      var props = properties(p), description = Object.keys(props).map(function (key) { return key + '：' + props[key]; }).join('\n');
      return '<Placemark><name>' + xml('No.' + p.no + ' ' + p.cat) + '</name><description>' + xml(description) + '</description>' + (styles[p.cat] ? '<styleUrl>#' + styles[p.cat] + '</styleUrl>' : '') + '<ExtendedData>' + Object.keys(props).map(function (key) { return '<Data name="' + xml(key) + '"><value>' + xml(props[key]) + '</value></Data>'; }).join('') + '</ExtendedData><Point><coordinates>' + p.lng + ',' + p.lat + ',0</coordinates></Point></Placemark>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' + definitions + marks + '</Document></kml>';
  }
  root.SPM.exporter = { toCsv: toCsv, toGeoJson: toGeoJson, toKml: toKml, googleMapsUrl: googleMapsUrl };
})(typeof window !== 'undefined' ? window : globalThis);
