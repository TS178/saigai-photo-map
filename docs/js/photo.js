(function (root) {
  'use strict';
  root.SPM = root.SPM || {};
  var unsupported = 'この写真の形式は送れません。カメラの設定で「互換性優先」（iPhone）にするか、別の写真を選んでください';
  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer), pieces = [];
    for (var i = 0; i < bytes.length; i += 8192) pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    return root.btoa(pieces.join(''));
  }
  async function decode(file) {
    if (root.createImageBitmap) { try { var bitmap = await root.createImageBitmap(file, { imageOrientation: 'from-image' }); return { image: bitmap, close: function () { bitmap.close(); } }; } catch (e) { /* imgでも読めるか確かめる。 */ } }
    var url = root.URL.createObjectURL(file), img = root.document.createElement('img');
    try {
      if (img.decode) { img.src = url; await img.decode(); }
      else await new Promise(function (resolve, reject) { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', reject, { once: true }); img.src = url; });
      return { image: img, close: function () { img.removeAttribute('src'); root.URL.revokeObjectURL(url); } };
    } catch (e) { root.URL.revokeObjectURL(url); throw new Error(unsupported); }
  }
  async function jpeg(image, max, quality) {
    var width = image.width || image.naturalWidth, height = image.height || image.naturalHeight;
    if (!width || !height) throw new Error(unsupported);
    var scale = Math.min(1, max / Math.max(width, height)), canvas = root.document.createElement('canvas');
    try {
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      var ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
      if (!blob) throw new Error('写真を縮小できませんでした。別の写真を選んでください。');
      return await blob.arrayBuffer();
    } finally { canvas.width = 0; canvas.height = 0; }
  }
  async function process(file) {
    var exif = root.SPM.exif.readExif(await file.slice(0, 256 * 1024).arrayBuffer()), decoded = await decode(file);
    try {
      var img = await jpeg(decoded.image, 2048, 0.82);
      if (4 * Math.ceil(img.byteLength / 3) > 2700000) img = await jpeg(decoded.image, 1600, 0.7);
      var thumb = await jpeg(decoded.image, 320, 0.7);
      if (4 * Math.ceil(thumb.byteLength / 3) > 45000) thumb = await jpeg(decoded.image, 240, 0.6);
      if (4 * Math.ceil(thumb.byteLength / 3) > 45000 || 4 * Math.ceil(img.byteLength / 3) > 2700000) throw new Error('写真が大きすぎます。別の写真を選んでください。');
      return { img: img, thumb: thumb, exif: exif, shot: exif && exif.takenAt || root.SPM.util.formatJst(new Date(file.lastModified || Date.now())), fileKey: JSON.stringify([file.name, file.size, file.lastModified]) };
    } finally { decoded.close(); }
  }
  root.SPM.photo = { process: process, toBase64: toBase64 };
})(typeof window !== 'undefined' ? window : globalThis);
