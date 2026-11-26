(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var table = new Uint32Array(256);
  for (var t = 0; t < 256; t++) { var c = t; for (var bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); table[t] = c >>> 0; }
  function crc32(bytes) { var crc = 0xffffffff; for (var i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
  function makeZip(entries) {
    if (entries.length > 65535) throw new Error('ZIPに入れるファイルが多すぎます。');
    var encoder = new TextEncoder(), local = [], central = [], offset = 0, centralSize = 0;
    entries.forEach(function (entry) {
      var name = encoder.encode(entry.name), data = entry.data;
      if (!ArrayBuffer.isView(data)) data = new Uint8Array(data);
      else data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (!name.length || name.length > 65535 || data.length > 0xffffffff) throw new Error('ZIPのファイル名または画像が大きすぎます。');
      var date = new Date(entry.date || Date.now());
      if (!Number.isFinite(date.getTime())) date = new Date(1980, 0, 1);
      var year = Math.min(2107, Math.max(1980, date.getFullYear()));
      var time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
      var day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(), crc = crc32(data);
      var header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(10, time, true); h.setUint16(12, day, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
      var directory = new Uint8Array(46 + name.length), d = new DataView(directory.buffer);
      d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true);
      d.setUint16(12, time, true); d.setUint16(14, day, true); d.setUint32(16, crc, true);
      d.setUint32(20, data.length, true); d.setUint32(24, data.length, true); d.setUint16(28, name.length, true);
      d.setUint32(42, offset, true); directory.set(name, 46);
      local.push(header, data); central.push(directory); offset += header.length + data.length; centralSize += directory.length;
      if (offset + centralSize + 22 > 0xffffffff) throw new Error('ZIP全体が大きすぎます。写真を分けて保存してください。');
    });
    var tail = new Uint8Array(22), e = new DataView(tail.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    var result = new Uint8Array(offset + centralSize + 22), pos = 0;
    local.concat(central, [tail]).forEach(function (chunk) { result.set(chunk, pos); pos += chunk.length; });
    return result;
  }
  root.SPM.zip = { makeZip: makeZip, crc32: crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
