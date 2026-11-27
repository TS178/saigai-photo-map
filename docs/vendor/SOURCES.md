# 同梱している部品（JavaScript部品は公式の npm 配布物から取り込み、照合値を確認済み 2026-11-26）

| 部品 | 版 | ライセンス | 取り込み元 | 照合値（npm dist.integrity） |
|---|---|---|---|---|
| Leaflet | 1.9.4 | BSD-2-Clause（leaflet/LICENSE） | https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz | sha512-nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA== |
| Leaflet.markercluster | 1.5.3 | MIT（markercluster/MIT-LICENCE.txt） | https://registry.npmjs.org/leaflet.markercluster/-/leaflet.markercluster-1.5.3.tgz | sha512-vPTw/Bndq7eQHjLBVlWpnGeLa3t+3zGiuM7fJwCkiMFq+nmRuG3RI3f7f4N4TDX7T4NpbAXpR2+NTRSEGfCSeA== |
| qrcode-generator | 2.0.4 | MIT（qrcode-generator/LICENSE は公式リポジトリ kazuhikoarase/qrcode-generator の LICENSE） | https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-2.0.4.tgz | sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g== |

いずれも実行時に必要な依存部品はない。QRコードは株式会社デンソーウェーブの登録商標です。

## Noto Sans JP

- 出所：Google Fonts 公式の Noto Sans JP（https://fonts.google.com/noto/specimen/Noto+Sans+JP、https://fonts.googleapis.com/css2 の太さ400・700。配布元 https://fonts.gstatic.com/）。
- ライセンス：SIL Open Font License 1.1（`../fonts/noto-sans-jp/OFL.txt`）。
- 取り込み日：2026-11-27。
- 同梱先：`../fonts/noto-sans-jp/`。分割woff2 124個とCSSをそのまま使用し、外部へのフォント通信は行わない。
