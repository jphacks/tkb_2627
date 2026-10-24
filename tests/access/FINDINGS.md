# T03 FINDINGS (tests/access)

base: 3155224（main）。matrix.test.ts の全131件が通過。it.skip にしたテストはない。

## 実装の不具合
なし。

## 確認した実装の挙動（契約どおりとして固定）
- 他人の旅程を baseTripId に指定した plan-batches の作成は 404（存在しない旅程と同一の応答）。apply-candidate まで到達しない。
- 除外時に宛先指定の招待は consumed になるため、除外された利用者が受諾すると 409（ALREADY_COMMITTED）。参加はできない。

## 未検証（E02 実装後に追加）
- PDF出力・写真配信の権限は未検証。ルートが存在しないため、`/trips/:id/pdf`、`/trips/:id/export`、`/posts/:id/pdf`、`/photos/:id` が全利用者で 404 になることだけを確認している。
- E02 実装後に追加すること：(1) 旅程PDFは本人のみ、(2) 投稿PDF/写真は canReadPost と同じ表（private/group/public x 5者）、(3) 除外直後に同URLが404、(4) license 不明の写真・mayExport=false が出力に含まれない。matrix.test.ts の "missing routes" ブロックはルート実装時に失敗するので置き換える。

## 本タスクの範囲外
- model/visibility.json の「Claudeによる新規生成」行は、apps/server/test/exposure.test.ts と static.test.ts（O01：共有入口で /local/* が常に404）で担保している。tests/access では扱わない。
- 招待の期限切れは時刻注入ができないため未網羅（packages/db の既存試験が担当）。
- 受入シナリオ2は、trips の PATCH に加え、候補採用（apply-candidate を古い expectedRevision で）も 409 になり既存データが不変であることを追加した。
