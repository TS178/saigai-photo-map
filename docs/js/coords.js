(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  function point(lat, lng, kind) {
    lat = Number(lat); lng = Number(lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, kind: kind } : null;
  }
  function parseLocationText(text) {
    if (text === null || text === undefined) return null;
    var s = String(text).normalize('NFKC').trim(), m, num = '([+-]?\\d+(?:\\.\\d+)?)';
    if (/^https?:\/\//i.test(s)) {
      var url = /^(https?):\/\/([^\/?#]+)([^#]*)?(?:#.*)?$/i.exec(s);
      if (!url || url[1].toLowerCase() !== 'https') return null;
      var host = url[2].toLowerCase();
      if (['maps.app.goo.gl', 'goo.gl', 'google.com', 'www.google.com', 'maps.google.com', 'google.co.jp', 'www.google.co.jp', 'maps.google.co.jp'].indexOf(host) < 0) return null;
      if (host === 'maps.app.goo.gl' || host === 'goo.gl') return { needsResolve: true, url: s };
      try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return null; }
      var patterns = [new RegExp('!3d' + num + '!4d' + num), new RegExp('@' + num + ',' + num), new RegExp('[?&](?:q|query|ll|center|destination)=\\s*' + num + '\\s*[, ]\\s*' + num), new RegExp('/(?:search|place)/\\s*' + num + '\\s*,\\s*' + num)];
      for (var i = 0; i < patterns.length; i++) { m = patterns[i].exec(s); if (m) return point(m[1], m[2], 'url'); }
      return null;
    }
    m = new RegExp('^' + num + '\\s*[,\\s]\\s*' + num + '$').exec(s);
    if (m) return point(m[1], m[2], 'coords');
    m = new RegExp('^(?:北緯|N)\\s*' + num + '\\s*(?:東経|E)\\s*' + num + '$', 'i').exec(s);
    if (m) return point(m[1], m[2], 'coords');
    m = /^(\d+(?:\.\d+)?)\s*[°度]\s*(\d+(?:\.\d+)?)\s*['′分]\s*(\d+(?:\.\d+)?)\s*["″秒]\s*([NS])\s+(\d+(?:\.\d+)?)\s*[°度]\s*(\d+(?:\.\d+)?)\s*['′分]\s*(\d+(?:\.\d+)?)\s*["″秒]\s*([EW])$/i.exec(s);
    if (!m || Number(m[2]) >= 60 || Number(m[3]) >= 60 || Number(m[6]) >= 60 || Number(m[7]) >= 60) return null;
    return point((Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * (/S/i.test(m[4]) ? -1 : 1), (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600) * (/W/i.test(m[8]) ? -1 : 1), 'coords');
  }
  root.SPM.coords = { parseLocationText: parseLocationText };
})(typeof window !== 'undefined' ? window : globalThis);
