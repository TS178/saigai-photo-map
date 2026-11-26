(function (root) {
  'use strict';
// II（リトルエンディアン）とMM（ビッグエンディアン）の同じEXIFを作る。
function makeExifApp1(options = {}) {
  const little = options.endian ? options.endian === 'II' : options.littleEndian !== false;
  const lat = options.lat === undefined ? 37.0412 : options.lat;
  const lng = options.lng === undefined ? 136.7790 : options.lng;
  const takenAt = (options.takenAt || '2027:07:01 14:32:10').replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1:$2:$3');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('試験用の座標が範囲外です。');
  const tiff = new Uint8Array(190), view = new DataView(tiff.buffer);
  const u16 = (at, value) => view.setUint16(at, value, little);
  const u32 = (at, value) => view.setUint32(at, value, little);
  tiff[0] = tiff[1] = little ? 73 : 77; u16(2, 42); u32(4, 8);
  function tag(at, id, type, count, value) {
    u16(at, id); u16(at + 2, type); u32(at + 4, count);
    if (type === 3 && count === 1) u16(at + 8, value); else u32(at + 8, value);
  }
  u16(8, 3);
  tag(10, 0x0112, 3, 1, options.orientation || 1);
  tag(22, 0x8769, 4, 1, 50);
  tag(34, 0x8825, 4, 1, 68);
  u32(46, 0);
  u16(50, 1); tag(52, 0x9003, 2, 20, 122); u32(64, 0);
  u16(68, 4);
  tag(70, 1, 2, 2, 0); tiff[78] = lat < 0 ? 83 : 78;
  tag(82, 2, 5, 3, 142);
  tag(94, 3, 2, 2, 0); tiff[102] = lng < 0 ? 87 : 69;
  tag(106, 4, 5, 3, 166); u32(118, 0);
  for (let i = 0; i < Math.min(19, takenAt.length); i++) tiff[122 + i] = takenAt.charCodeAt(i);
  function rational(at, value) {
    const positive = Math.abs(value), deg = Math.floor(positive), minutes = (positive - deg) * 60, min = Math.floor(minutes);
    u32(at, deg); u32(at + 4, 1); u32(at + 8, min); u32(at + 12, 1);
    u32(at + 16, Math.round((minutes - min) * 60 * 1000000)); u32(at + 20, 1000000);
  }
  rational(142, lat); rational(166, lng);
  const app1 = new Uint8Array(200);
  app1.set([255, 225, 0, 198, 69, 120, 105, 102, 0, 0]); app1.set(tiff, 10);
  return app1;
}
function insertExif(jpeg, options = {}) {
  const bytes = ArrayBuffer.isView(jpeg) ? new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength) : new Uint8Array(jpeg);
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('試験用のJPEGを渡してください。');
  const app1 = makeExifApp1(options), result = new Uint8Array(bytes.length + app1.length);
  result.set(bytes.subarray(0, 2)); result.set(app1, 2); result.set(bytes.subarray(2), 2 + app1.length);
  return result;
}
function makeExifJpeg(options = {}) { return insertExif(new Uint8Array([255, 216, 255, 217]), options); }
  root.SPM_EXIF_FIXTURE = { makeExifApp1: makeExifApp1, makeExifJpeg: makeExifJpeg, insertExif: insertExif };
})(typeof window !== 'undefined' ? window : globalThis);

