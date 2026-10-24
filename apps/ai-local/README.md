# @tkb/ai-local — 本人用App Server（:4311）

本人PCのloopbackだけで動きます。トンネルやLANに公開しません。

## 起動とペアリング
1. `.env.ai-local`に`PERSONAL_OWNER_USER_ID=<自分のアプリuserId>`を1つだけ設定します。他メンバーや審査員のIDは入れません（docs/claude-connection-check.md）。
2. `npm run dev:local`を実行すると、端末に1回だけ使えるペアリングコードが表示されます（10分有効、誤入力5回で無効）。
3. 画面で`POST /local/v1/pair`にコードを送ると、HttpOnlyのローカルcookieと`csrfToken`を受け取れます。再読込後は`GET /local/v1/session`で`csrfToken`を再取得します。
4. `POST /local/v1/auth/login`で共有サーバーにログインします。上流のcookieとCSRFはこのプロセスの中だけに保持します。

## 制約（A02時点）
- ログアウトとセッション破棄のAPIはありません。セッションはメモリ上だけにあり、有効期間は12時間です。cookieを失った場合やコードの期限が切れた場合は、プロセスを再起動して新しいコードを表示させます。
- 生成はfake runnerだけで行い、実CLIは起動しません（A04でA01の了承後に実装）。正しい結果が出ても、候補保存（S04/A04）ができるまではジョブを`failed/UNAVAILABLE`で終えます。
- `baseTripId`、`expectedRevision`、`mode=replan`は422を返します（所有確認はA04、replanはA06）。
- 上流へのloginリクエストにはOriginを付けません。S02がOriginなしのリクエストを受け付けているためです。必須になった場合は、固定の共有originを付けます。

## ジョブの再試行（A03）
- ジョブ状態は`AI_JOB_DIR`（既定`.local/ai-local/`、Git対象外）にメタデータだけ保存します。制約・プロンプト・cookieは保存しません。
- 再起動時に未完了のジョブは`failed/WORKER_RESTARTED`になります。保存済みのbatchが見つかればその`batchId`で`succeeded`になります。
- `WORKER_RESTARTED`は**同じIdempotency-Key**で再送できます（新しい試行が同じoperationKeyで始まり、先にbatchの有無を確認します）。
- それ以外の`retryable=true`のエラー（`CLI_EXIT`、`CLI_TIMEOUT`等）は、同じキーでは同じ失敗結果が返ります。再試行には**新しいIdempotency-Key**が必要です。ただし保存段階以降の失敗は保存結果が不明なため、同じキーでの再送が新しい試行になります。
