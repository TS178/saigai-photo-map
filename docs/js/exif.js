(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  // APP1の終端を境界にして、ほかのセグメントを誤って読まないようにする。
  function readExif(input) {
    try {
      var bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
      var p = 2;
      while (p + 4 <= bytes.length) {
        if (bytes[p] !== 255) return null;
        while (bytes[p + 1] === 255) p++;
        var marker = bytes[p + 1];
        if (marker === 0xda || marker === 0xd9) return null;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { p += 2; continue; }
        var size = view.getUint16(p + 2), end = p + 2 + size;
        if (size < 2 || end > bytes.length) return null;
        if (marker === 0xe1 && size >= 16 && bytes[p + 4] === 69 && bytes[p + 5] === 120 && bytes[p + 6] === 105 && bytes[p + 7] === 102 && bytes[p + 8] === 0 && bytes[p + 9] === 0) {
          var start = p + 10, little = bytes[start] === 73 && bytes[start + 1] === 73;
          if (!little && !(bytes[start] === 77 && bytes[start + 1] === 77)) return null;
          function bound(o, n) { if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < start || n < 0 || o + n > end) throw new Error('EXIFの範囲外です。'); }
          function u16(o) { bound(o, 2); return view.getUint16(o, little); }
          function u32(o) { bound(o, 4); return view.getUint32(o, little); }
          if (u16(start + 2) !== 42) return null;
          function ifd(offset) {
            var at = start + offset, count = u16(at), tags = {};
            bound(at + 2, count * 12 + 4);
            for (var i = 0; i < count; i++) {
              var entry = at + 2 + i * 12, type = u16(entry + 2), n = u32(entry + 4), width = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type];
              if (!width) continue;
              var len = n * width, data = len <= 4 ? entry + 8 : start + u32(entry + 8);
              bound(data, len); tags[u16(entry)] = { type: type, count: n, data: data };
            }
            return tags;
          }
          function ascii(tag) {
            if (!tag || tag.type !== 2 || tag.count > 128) return '';
            var str = ''; for (var i = 0; i < tag.count && bytes[tag.data + i]; i++) str += String.fromCharCode(bytes[tag.data + i]);
            return str;
          }
          function pointer(tag) { return tag && tag.type === 4 && tag.count === 1 ? u32(tag.data) : 0; }
          function dms(tag) {
            if (!tag || tag.type !== 5 || tag.count !== 3) return null;
            var values = [];
            for (var i = 0; i < 3; i++) { var den = u32(tag.data + i * 8 + 4); if (!den) return null; values.push(u32(tag.data + i * 8) / den); }
            if (values[1] >= 60 || values[2] >= 60) return null;
            return values[0] + values[1] / 60 + values[2] / 3600;
          }
          var first = ifd(u32(start + 4)), ex = pointer(first[0x8769]), gps = pointer(first[0x8825]);
          var result = { lat: null, lng: null, takenAt: null, orientation: null };
          if (first[0x0112] && first[0x0112].type === 3 && first[0x0112].count === 1) { var orient = u16(first[0x0112].data); if (orient >= 1 && orient <= 8) result.orientation = orient; }
          if (ex) {
            var date = ascii(ifd(ex)[0x9003]), match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(date);
            if (match) {
              var nums = match.slice(1).map(Number), d = new Date(Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]));
              if (d.getUTCFullYear() === nums[0] && d.getUTCMonth() + 1 === nums[1] && d.getUTCDate() === nums[2] && d.getUTCHours() === nums[3] && d.getUTCMinutes() === nums[4] && d.getUTCSeconds() === nums[5]) result.takenAt = match[1] + '/' + match[2] + '/' + match[3] + ' ' + match[4] + ':' + match[5] + ':' + match[6];
            }
          }
          if (gps) {
            var g = ifd(gps), lat = dms(g[2]), lng = dms(g[4]), ns = ascii(g[1]), ew = ascii(g[3]);
            if (lat !== null && lng !== null && lat <= 90 && lng <= 180 && /^[NS]$/.test(ns) && /^[EW]$/.test(ew)) { result.lat = lat * (ns === 'S' ? -1 : 1); result.lng = lng * (ew === 'W' ? -1 : 1); }
          }
          return result;
        }
        p = end;
      }
      return null;
    } catch (e) { return null; }
  }
  root.SPM.exif = { readExif: readExif };
})(typeof window !== 'undefined' ? window : globalThis);
