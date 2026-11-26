import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import { makeExifApp1, makeExifJpeg, insertExif } from './fixtures/exif-fixture.mjs';
import { createGas } from './lib/gas-mock.mjs';

const root = new URL('../', import.meta.url);
function read(path) { return fs.readFileSync(new URL(path, root), 'utf8'); }
function modules(extra = {}) {
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, ...extra });
  for (const name of ['util', 'exif', 'coords', 'zip', 'export']) new vm.Script(read('docs/js/' + name + '.js'), { filename: name + '.js' }).runInContext(context);
  return context.SPM;
}
const S = modules();
const plain = value => JSON.parse(JSON.stringify(value));

test('合言葉の正規化は共通の例とGASの結果に一致する', () => {
  const gas = createGas();
  for (const example of JSON.parse(read('tests/fixtures/codes.json'))) {
    assert.equal(S.util.normCode(example.input), example.expected);
    assert.equal(S.util.normCode(example.input), gas.call('normCode_', example.input));
  }
});

test('util：全角・読み上げ・日時・ファイル名・距離・端末', () => {
  assert.equal(S.util.toHalfWidth('Ａｂ１２　'), 'Ab12 ');
  const digits = Array.from(webcrypto.getRandomValues(new Uint8Array(8)), n => String(n % 10)).join('');
  const names = ['ゼロ', 'イチ', 'ニ', 'サン', 'ヨン', 'ゴ', 'ロク', 'ナナ', 'ハチ', 'キュウ'];
  assert.equal(S.util.formatCode(digits), digits.slice(0, 4) + '-' + digits.slice(4));
  assert.equal(S.util.readCode(digits), digits.split('').map((n, i) => names[Number(n)] + (i === 3 ? '、' : i === 7 ? '' : ' ')).join(''));
  assert.equal(S.util.formatCode('Ａ-b'), 'ab');
  assert.equal(S.util.formatJst(new Date('2027-07-01T23:12:45Z')), '2027/07/02 08:12:45');
  assert.equal(S.util.formatJst(new Date('invalid')), '');
  assert.equal(S.util.safeFileName('a/b:c* d?"<>|\\'), 'a_b_c__d______');
  assert.equal(Array.from(S.util.safeFileName('写真😀名前', 3)).length, 3);
  assert.equal(S.util.clampText('あ😀い\r\nえ\u0000', 4), 'あ😀い\n');
  for (const [ua, expected] of [['iPhone', 'iPhone'], ['Android', 'Android'], ['Windows NT', 'PC'], ['Macintosh', 'PC'], ['', 'その他']]) assert.equal(S.util.deviceKind(ua), expected);
  assert.equal(S.util.distanceMeters(37, 136, 37, 136), 0);
  assert.ok(Math.abs(S.util.distanceMeters(0, 0, 0, 1) - 111195) < 2);
});

test('UUIDは標準とgetRandomValuesの代替経路の両方で作れる', () => {
  const fallback = modules({ crypto: { getRandomValues: bytes => webcrypto.getRandomValues(bytes) } }).util;
  for (const util of [S.util, fallback]) {
    const ids = new Set(Array.from({ length: 20 }, () => util.uuid()));
    assert.equal(ids.size, 20);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

for (const endian of ['II', 'MM']) for (const sign of [1, -1]) {
  test('EXIF：' + endian + '・' + (sign === 1 ? 'N/E' : 'S/W') + '・日時・向き', () => {
    const jpeg = makeExifJpeg({ endian, lat: 37.0412 * sign, lng: 136.779 * sign, orientation: 6 });
    const exif = S.exif.readExif(jpeg);
    assert.ok(Math.abs(exif.lat - 37.0412 * sign) < 1e-7);
    assert.ok(Math.abs(exif.lng - 136.779 * sign) < 1e-7);
    assert.equal(exif.takenAt, '2027/07/01 14:32:10'); assert.equal(exif.orientation, 6);
    assert.deepEqual(plain(S.exif.readExif(jpeg.buffer)), plain(exif));
    const wrapped = new Uint8Array(jpeg.length + 10); wrapped.set(jpeg, 5);
    assert.deepEqual(plain(S.exif.readExif(wrapped.subarray(5, -5))), plain(exif));
  });
}

test('EXIF：切れたデータ・巨大なIFD・ゼロの分母・無い日時で例外を出さない', () => {
  assert.equal(S.exif.readExif(new Uint8Array([255, 216, 255, 217])), null);
  assert.equal(S.exif.readExif(new Uint8Array([0, 0, 0])), null);
  assert.equal(S.exif.readExif(null), null);
  const complete = makeExifJpeg();
  for (let n = 0; n < complete.length - 2; n++) assert.equal(S.exif.readExif(complete.subarray(0, n)), null);
  const broken = makeExifJpeg(); new DataView(broken.buffer).setUint32(16, 0xfffffff0, true);
  assert.equal(S.exif.readExif(broken), null);
  const denominator = makeExifJpeg(); new DataView(denominator.buffer).setUint32(12 + 142 + 4, 0, true);
  const withoutGps = S.exif.readExif(denominator); assert.equal(withoutGps.lat, null); assert.equal(withoutGps.lng, null);
  assert.equal(S.exif.readExif(makeExifJpeg({ takenAt: '2027:02:30 14:00:00' })).takenAt, null);
  // 別のAPP1を先に置いてもExifのAPP1まで探す。
  const other = new Uint8Array(complete.length + 6);
  other.set([255, 216, 255, 225, 0, 4, 0, 0]); other.set(complete.subarray(2), 8);
  assert.ok(S.exif.readExif(other).lat);
  assert.equal(insertExif(new Uint8Array([255, 216, 255, 217])).length, makeExifApp1().length + 4);
});

test('EXIFのブラウザ版とNode版は同じAPP1を作る', () => {
  const context = vm.createContext({});
  new vm.Script(read('tests/fixtures/exif-fixture-browser.js')).runInContext(context);
  for (const endian of ['II', 'MM']) {
    const options = { endian, lat: -37.0412, lng: -136.779 };
    assert.deepEqual(Array.from(context.SPM_EXIF_FIXTURE.makeExifApp1(options)), Array.from(makeExifApp1(options)));
  }
});

test('座標：数字・全角・日本語・度分秒・Googleマップの全形式', () => {
  const cases = [
    ['37.0412, 136.7790', 37.0412, 136.779, 'coords'], ['37.0412 136.7790', 37.0412, 136.779, 'coords'],
    ['37.0412,136.7790', 37.0412, 136.779, 'coords'], ['３７．０４１２，１３６．７７９０', 37.0412, 136.779, 'coords'],
    ['北緯37.0412 東経136.7790', 37.0412, 136.779, 'coords'], ['N37.0412 E136.7790', 37.0412, 136.779, 'coords'],
    ['37°02\'28.4"N 136°46\'44.4"E', 37.041222, 136.779, 'coords'], ['37°02\'28.4"S 136°46\'44.4"W', -37.041222, -136.779, 'coords'],
    ['https://www.google.com/maps/@35,135,15z/data=!3d37.0412!4d136.7790', 37.0412, 136.779, 'url'],
    ['https://maps.google.co.jp/maps/@37.0412,136.7790,15z', 37.0412, 136.779, 'url'],
    ['https://www.google.com/maps?q=37.0412%2C+136.7790', 37.0412, 136.779, 'url'],
    ['https://google.com/maps/search/37.0412,+136.7790', 37.0412, 136.779, 'url'],
    ['https://google.com/maps/place/37.0412,136.7790', 37.0412, 136.779, 'url']
  ];
  for (const key of ['query', 'll', 'center', 'destination']) cases.push(['https://www.google.co.jp/maps?api=1&' + key + '=37.0412%2C136.7790', 37.0412, 136.779, 'url']);
  for (const [input, lat, lng, kind] of cases) assert.deepEqual(plain(S.coords.parseLocationText(input)), { lat, lng, kind }, input);
  for (const url of ['https://maps.app.goo.gl/example', 'https://goo.gl/maps/example']) assert.deepEqual(plain(S.coords.parseLocationText(url)), { needsResolve: true, url });
  for (const input of ['', null, '91, 136', '37,181', '37°60\'0"N 136°0\'0"E', 'http://google.com/maps?q=37,136', 'https://google.com.evil.test/?q=37,136', 'https://google.com@evil.test/?q=37,136', 'https://google.com/maps?q=%xx', '場所の名前']) assert.equal(S.coords.parseLocationText(input), null, input);
});

// ZIPを出力側の関数に頼らず、仕様の各ヘッダーから読み直す。
function independentCrc(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); }
  return (n ^ 0xffffffff) >>> 0;
}
function inspectZip(input) {
  const bytes = Buffer.from(input), end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 4), 0); assert.equal(bytes.readUInt16LE(end + 6), 0);
  const count = bytes.readUInt16LE(end + 10); assert.equal(bytes.readUInt16LE(end + 8), count);
  let cursor = bytes.readUInt32LE(end + 16); const start = cursor, entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50); assert.equal(bytes.readUInt16LE(cursor + 8) & 0x0800, 0x0800);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0);
    const length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50); assert.equal(bytes.readUInt16LE(local + 6) & 0x0800, 0x0800);
    assert.equal(bytes.readUInt16LE(local + 8), 0); assert.equal(bytes.readUInt32LE(local + 18), length);
    assert.equal(bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8'), name);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28), data = bytes.subarray(dataStart, dataStart + length);
    assert.equal(independentCrc(data), bytes.readUInt32LE(cursor + 16)); assert.equal(independentCrc(data), bytes.readUInt32LE(local + 14));
    entries.push({ name, data, time: bytes.readUInt16LE(local + 10), day: bytes.readUInt16LE(local + 12) });
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end); assert.equal(cursor - start, bytes.readUInt32LE(end + 12)); return entries;
}
test('ZIP：中央ディレクトリ・日本語の名前・CRC・DOS日時・空のZIP', () => {
  const date = new Date(2027, 6, 1, 14, 32, 10), data = new TextEncoder().encode('写真の一覧\r\nあいうえお');
  const entries = inspectZip(S.zip.makeZip([{ name: '一覧.csv', data, date }, { name: '写真/被害.jpg', data: new Uint8Array([255, 216, 255, 217]), date }]));
  assert.equal(entries.length, 2); assert.equal(entries[0].name, '一覧.csv'); assert.equal(entries[1].name, '写真/被害.jpg');
  assert.deepEqual(entries[0].data, Buffer.from(data));
  assert.equal(entries[0].time, (14 << 11) | (32 << 5) | 5); assert.equal(entries[0].day, ((2027 - 1980) << 9) | (7 << 5) | 1);
  assert.deepEqual(inspectZip(S.zip.makeZip([])), []);
});

test('出力：CSVのBOM・改行・囲み・数式対策', () => {
  const p = { pid: randomUUID(), no: 12, cat: '=区分', note: '道路,"冠水"\n注意', who: '@名前', org: '\t所属', memo: '\rメモ', lat: 37, lng: 136, src: 'map', urgent: true };
  const photos = [{ id: randomUUID(), n: 1, shot: '2027/07/01 14:32:10' }, { id: randomUUID(), n: 2 }];
  const csv = S.exporter.toCsv([p], { [p.pid]: photos });
  assert.equal(csv.charCodeAt(0), 0xfeff); assert.ok(csv.endsWith('\r\n')); assert.ok(csv.includes('\r\n12,1,')); assert.ok(csv.includes('\r\n12,2,'));
  assert.ok(csv.includes("'=区分")); assert.ok(csv.includes("'@名前")); assert.ok(csv.includes("'\t所属")); assert.ok(csv.includes('"\'\rメモ"'));
  assert.ok(csv.includes('"道路,""冠水""\n注意"')); assert.ok(csv.includes('地図で指定'));
  for (const value of ['=SUM(A1)', '+1', '-1', '@name', '\t名前', '\r名前']) assert.ok(S.exporter.toCsv([{ ...p, who: value }]).includes("'" + value));
});

test('出力：GeoJSONは経度・緯度順、KMLはXMLの特殊文字を置き換える', () => {
  const p = { no: 12, pid: randomUUID(), lat: 37.0412, lng: 136.779, cat: '区分<&"\'', note: '<被害>&"\'', photos: [{ id: randomUUID() }, { id: randomUUID() }] };
  const posts = [p, { ...p, no: 13, lng: 137 }, { ...p, lat: null, lng: null }];
  const geo = S.exporter.toGeoJson(posts); assert.equal(geo.features.length, 2);
  assert.deepEqual(Array.from(geo.features[0].geometry.coordinates), [136.779, 37.0412]); assert.equal(geo.features[0].properties['写真の数'], 2);
  const kml = S.exporter.toKml(posts, [{ name: p.cat, color: '#0072B2' }]);
  assert.equal((kml.match(/<Placemark>/g) || []).length, 2); assert.ok(kml.includes('ffB27200')); assert.ok(kml.includes('&lt;被害&gt;&amp;&quot;&apos;')); assert.ok(!kml.includes('<被害>'));
  assert.ok(kml.includes('xmlns="http://www.opengis.net/kml/2.2"')); assert.ok(kml.includes('<coordinates>136.779,37.0412,0</coordinates>'));
  assert.equal(S.exporter.googleMapsUrl(null, null), ''); assert.equal(S.exporter.googleMapsUrl(37, 136), 'https://www.google.com/maps/search/?api=1&query=37,136');
});
