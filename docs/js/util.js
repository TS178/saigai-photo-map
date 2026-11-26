(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  function uuid() {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    var h = Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function text(s) { return s === null || s === undefined ? '' : String(s); }
  function toHalfWidth(s) { return text(s).normalize('NFKC'); }
  function normCode(s) { return toHalfWidth(s).replace(/[\s\-‐‑‒–—―−ーｰ]/g, '').toLowerCase(); }
  function formatCode(s) { s = normCode(s); return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4) : s; }
  function readCode(s) {
    s = normCode(s);
    var names = ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ'];
    return /^\d{8}$/.test(s) ? s.split('').map(function (c, i) { return names[Number(c)] + (i === 3 ? '、' : i === 7 ? '' : ' '); }).join('') : s;
  }
  function formatJst(date) {
    var d = new Date(new Date(date).getTime() + 9 * 3600000);
    if (!Number.isFinite(d.getTime())) return '';
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  }
  function clampText(s, n) { return Array.from(text(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')).slice(0, n).join(''); }
  function deviceKind(ua) {
    ua = text(ua);
    return /iPhone|iPad|iPod/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android' : /Windows|Macintosh|Linux|CrOS/i.test(ua) ? 'PC' : 'その他';
  }
  function distanceMeters(lat1, lng1, lat2, lng2) {
    if (typeof lat1 === 'object') { var a = lat1, b = lng1; lat1 = a.lat; lng1 = a.lng; lat2 = b.lat; lng2 = b.lng; }
    var r = Math.PI / 180, dlat = (lat2 - lat1) * r, dlng = (lng2 - lng1) * r;
    var h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dlng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }
  function safeFileName(s, max) { return Array.from(text(s).replace(/[\\/:*?"<>|\s\u0000-\u001f]/g, '_')).slice(0, max || 80).join('') || '写真'; }
  root.SPM.util = { uuid: uuid, formatJst: formatJst, toHalfWidth: toHalfWidth, normCode: normCode, formatCode: formatCode, readCode: readCode, clampText: clampText, deviceKind: deviceKind, distanceMeters: distanceMeters, safeFileName: safeFileName };
})(typeof window !== 'undefined' ? window : globalThis);
