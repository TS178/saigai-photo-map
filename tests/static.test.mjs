import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createGas } from './lib/gas-mock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function walk(folder) {
  return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const relative = folder + '/' + entry.name;
    return entry.isDirectory() ? [relative, ...walk(relative)] : [relative];
  });
}
const allDocs = walk('docs'), own = allDocs.filter(file => !file.startsWith('docs/vendor/') && /\.(?:js|html)$/.test(file));
const htmlFiles = own.filter(file => file.endsWith('.html'));

test('公開する名前と.nojekyll', () => {
  for (const file of allDocs) assert.ok(!path.basename(file).startsWith('_'), file);
  assert.ok(fs.statSync(path.join(root, 'docs/.nojekyll')).isFile());
});
test('GAS・設定・Service Workerの版が一致する', () => {
  const gas = read('gas/Code.gs'), version = gas.match(/var APP_VERSION\s*=\s*'([^']+)'/)[1];
  assert.equal(version, '1.1.0');
  assert.equal(gas.match(/var SPM_CODE_END\s*=\s*'([^']+)'/)[1], version);
  assert.match(gas.trimEnd().split('\n').pop(), /^var SPM_CODE_END = '[^']+';$/);
  assert.equal(read('docs/config.js').match(/expectedGasVersion:\s*'([^']+)'/)[1], version);
  assert.equal(read('docs/sw.js').match(/CACHE_VERSION\s*=\s*'([^']+)'/)[1], 'spm-' + version);
});
test('自作のJSとHTMLは危険なHTML挿入・動的コード・モジュールを使わない', () => {
  for (const file of own) {
    const source = read(file);
    assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\s*\.\s*write\s*\(|\beval\s*\(|\bnew\s+Function\b/, file);
    assert.doesNotMatch(source, /(?:^|[;{}\n])\s*(?:import\s*(?:[({*'"\w])|export\s+(?:default|const|let|var|function|class|\{|\*))/m, file);
  }
});
test('HTMLのスクリプト・イベント属性・CSP・検索避け・Referer', () => {
  for (const file of htmlFiles) {
    const source = read(file), tags = source.match(/<[a-z][^>]*>/gi) || [];
    for (const tag of tags) assert.doesNotMatch(tag, /\son[\w-]+\s*=/i, file + ': ' + tag);
    for (const script of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      assert.equal(script[2].trim(), '', file);
      assert.doesNotMatch(script[1], /\bsrc\s*=\s*["'](?:https?:)?\/\//i, file);
      assert.match(script[1], /\bsrc\s*=/i, file);
    }
    assert.match(source, /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]+"/i, file);
    assert.match(source, /<meta\s+name="robots"\s+content="noindex,nofollow"/i, file);
    assert.doesNotMatch(source, /no-referrer/i, file);
  }
});
test('Service Workerには投稿ページの必要ファイルだけを保存する', () => {
  const source = read('docs/sw.js'), match = source.match(/const APP_FILES\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(match, '保存一覧がある');
  const files = vm.runInNewContext(match[1]);
  const references = [...read('docs/index.html').matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gi)].map(m => m[1]);
  for (const file of ['index.html', 'help.html', ...references]) assert.ok(files.includes('./' + file), file);
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, 'docs', file)), file);
    assert.doesNotMatch(file, /admin|print|markercluster|qrcode|^https?:/i, file);
  }
  assert.match(source, /url\.origin\s*!==\s*scopeUrl\.origin/);
});
test('ライセンス・QRの商標・地図の出典とURL', () => {
  assert.ok(fs.existsSync(path.join(root, 'docs/vendor/SOURCES.md')));
  for (const folder of ['leaflet', 'markercluster', 'qrcode-generator']) {
    assert.ok(allDocs.some(file => file.startsWith('docs/vendor/' + folder + '/') && /licen[cs]e/i.test(path.basename(file))), folder);
  }
  assert.match(read('docs/js/share.js'), /QRコードは株式会社デンソーウェーブの登録商標です/);
  const maps = read('docs/js/mapbase.js'); assert.match(maps, /OpenStreetMap/); assert.match(maps, /地理院タイル/);
  assert.match(maps, /openstreetmap\.org\/copyright/); assert.match(maps, /maps\.gsi\.go\.jp\/development\/ichiran\.html/);
  assert.doesNotMatch(read('docs/config.js'), /https?:\/\/[^'"\s]*\{s\}[^'"\s]*openstreetmap/);
});

// コメント・文字列・正規表現内の波括弧を数えない小さな字句読み取り。
function topLevelDeclarations(source) {
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\n\\])+\/[gimsuy]*|[A-Za-z_$][\w$]*|[^\s]/g) || [];
  let depth = 0; const found = [];
  for (const token of tokens) {
    if (/^(?:\/|['"`])/.test(token)) continue;
    if (depth === 0 && /^(?:const|let)$/.test(token)) found.push(token);
    if (token === '{') depth++; if (token === '}') depth--;
  }
  return found;
}
test('GASのトップレベルにconst・letがない', () => {
  assert.deepEqual(topLevelDeclarations(read('gas/Code.gs')), []);
});
test('公開設定のURLは空かGASの公開URLで、試験で作った秘密を配布ファイルに含まない', () => {
  const context = vm.createContext({ window: {} }); vm.runInContext(read('docs/config.js'), context);
  assert.match(context.window.SPM_CONFIG.gasUrl, /^(?:https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec)?$/);
  const gas = createGas(); gas.call('setup_');
  const props = gas.props.getProperties(), P = gas.context.PROP;
  const secrets = [props[P.POST_CODE], props[P.ADMIN_PASS], props[P.SALT]];
  const textFiles = [...own, 'gas/Code.gs', 'gas/appsscript.json', 'README.md', ...walk('手引き').filter(file => /\.(?:html|css|js|md)$/.test(file))];
  for (const file of textFiles) for (const secret of secrets) assert.ok(secret && !read(file).includes(secret), file + 'に試験の秘密がない');
});
test('自作の配布ファイルはUTF-8・BOMなし・LF', () => {
  for (const file of [...own, 'gas/Code.gs', 'README.md', ...walk('手引き').filter(file => /\.(?:html|css)$/.test(file))]) {
    const data = fs.readFileSync(path.join(root, file));
    assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(data), file);
    assert.notEqual(data.subarray(0, 3).toString('hex'), 'efbbbf', file); assert.ok(!data.includes(13), file);
  }
});
