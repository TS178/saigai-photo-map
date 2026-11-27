import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'tests/e2e/shots'), destination = path.join(root, '手引き/img');
// 左が画面確認の撮影名、右が手引きで参照する名前。
const images = {
  'post-code.png': '投稿_合言葉.png', 'post-home.png': '投稿_ホーム.png',
  'post-field.png': '投稿_現地.png', 'post-batch.png': '投稿_まとめて.png',
  'post-place.png': '投稿_場所.png', 'post-result.png': '投稿_結果.png',
  'post-queue.png': '投稿_送信待ち.png', 'post-closed.png': '投稿_受付停止.png',
  'post-line.png': '投稿_LINE.png', 'admin-map.png': '管理_地図.png',
  'admin-cluster.png': '管理_束.png', 'admin-tiles.png': '管理_タイル.png',
  'admin-list.png': '管理_一覧.png', 'admin-detail.png': '管理_詳細.png',
  'admin-settings.png': '管理_設定.png', 'admin-past.png': '管理_過去.png',
  'admin-print.png': '管理_印刷.png',
  'post-video-card.png': '投稿_動画.png', 'post-video-progress.png': '投稿_動画送信中.png',
  'admin-detail-photo-map.png': '管理_詳細地図.png', 'admin-detail-video.png': '管理_動画詳細.png'
};
const missing = [];
for (const name of Object.keys(images)) {
  try { await fs.access(path.join(source, name)); } catch { missing.push(name); }
}
if (missing.length) {
  console.error('画像がまだありません。画面の自動確認を終えてから、もう一度実行してください。\n' + missing.join('\n'));
  process.exitCode = 1;
} else {
  await fs.mkdir(destination, { recursive: true });
  for (const [from, to] of Object.entries(images)) await fs.copyFile(path.join(source, from), path.join(destination, to));
  console.log('手引きの画像を ' + Object.keys(images).length + '枚 写しました。');
}
