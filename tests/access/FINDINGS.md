# T03 FINDINGS (tests/access)

base: 3155224（main）。matrix.test.ts の全131件が通過。it.skip にしたテストはない。

## 実装の不具合
なし。

## 確認した実装の挙動（契約どおりとして固定）
- 他人の旅程を baseTripId に指定した plan-batches の作成は 404（存在しない旅程と同一の応答）。apply-candidate まで到達しない。
- 除外時に宛先指定の招待は consumed になるため、除外された利用者が受諾すると 409（ALREADY_COMMITTED）。参加はできない。

## PDF出力（E02/K18）：追加済み
`exports.test.ts`（15件、実レンダラー使用、外部通信なし）。出力は本人のみで、group・投稿の閲覧権は広がらない。
- 他人（member/other/removed）の旅程への POST、他人の export の GET/DELETE は存在しない id と同一の 404、anonymous は 401。他人の DELETE 後も本人の export は残る。
- group member・投稿閲覧者は、自分に見える投稿の元旅程でも export を作れない。投稿ID・グループIDを旅程IDとして渡しても 404。
- 本人が export を削除、または旅程を削除すると、本人を含む全員 404（旅程削除後は再GETも404）。
- group 脱退/除外後も export の可否は変わらない（本人専用）。
- CSRF 無しは 403。
- 旅程削除のHTTP APIが無いため、旅程削除は DB 直接操作で再現した。

## 未検証
- 写真配信（`/photos/:id`）と投稿PDF（`/posts/:id/pdf`）はルート未実装。matrix.test.ts の 404 確認のみ（旧 `/trips/:id/pdf`・`/trips/:id/export` も404のまま）。実装時に canReadPost と同じ表を追加する。

## 本タスクの範囲外
- model/visibility.json の「Claudeによる新規生成」行は、apps/server/test/exposure.test.ts と static.test.ts（O01：共有入口で /local/* が常に404）で担保している。tests/access では扱わない。
- 招待の期限切れは時刻注入ができないため未網羅（packages/db の既存試験が担当）。
- 受入シナリオ2は、trips の PATCH に加え、候補採用（apply-candidate を古い expectedRevision で）も 409 になり既存データが不変であることを追加した。
