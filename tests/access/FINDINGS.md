# T03 FINDINGS (tests/access)

## 実装の不具合
なし。matrix.test.ts の全128件が現行 main(3155224) で通過した。it.skip にしたテストはない。

## 未実装による未網羅（E02 実装後に追加）
- PDF出力・写真配信の権限試験（R21/R26 の「PDF」）。現状は該当ルートが存在しないため、
  `GET /api/v1/trips/:id/pdf`、`/trips/:id/export`、`/posts/:id/pdf`、`/photos/:id` が全利用者で 404 になることだけを確認している。
- E02 実装後に追加すること：(1) 旅程PDFは本人のみ（他人・匿名・除外済みは404/401）、(2) 投稿PDF/写真は canReadPost と同じ表（private/group/public x 5者）、
  (3) 除外直後に同URLが404、(4) license 不明の写真・mayExport=false のデータが出力に含まれない。matrix.test.ts の "missing routes" ブロックは、ルートが実装された時点で失敗するので、置き換えること。

## 範囲外
- グループ招待の期限切れ（EXPIRED）は時刻注入ができないため未網羅（packages/db 側の既存試験が担当）。
- A02/A03（ローカルApp Server）の認可は tests/access の対象外。
