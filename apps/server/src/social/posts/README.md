# SNS投稿 (S05, K12-K15)

- snapshot はサーバーだけが元旅程から作る（`snapshot.ts`）。公開しないもの: privateNotes、budget、departure/return（自宅）、自宅の placeId を持つ place と、自宅に接する leg、provenance が export/store 不可または期限付きの place、license 不明の写真。除外した place を指す activity.placeId は null、leg の端点は `hidden_N`。
- 閲覧権限はSQLのWHERE句（`packages/db/src/posts.ts`）。group は現在の所属を毎回DBで確認する。見えない投稿は常に404。`/api/v1/posts` 配下は全て `Cache-Control: no-store`。
- 非所属・不存在の group を公開範囲に指定する preview / PATCH は 422（group の存在を漏らさない）。確定時（K13）に所属を失っていた場合は 404。
- **S04 の旅程削除は、同一 transaction で `hidePostsForTrip(db, tripId, ownerId)` を呼ぶこと。** `getPostForViewer` / `listFeed` は元旅程の deleted_at を見ない（投稿は固定コピーなので独立）。呼び忘れると、元旅程を削除しても公開投稿が残る。
- 公開は利用者の明示操作（preview → 確認 → 確定）だけで行う。旅行中（status=completed など）の公開は現在地の推測につながり得るので、U08 で注意表示を出すこと。
- preview は利用者ごとに未消費・期限内30件まで（超過は429）。
