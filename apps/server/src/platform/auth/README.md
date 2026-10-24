# 認証と認可基盤 (S02)

- cookie `tkb_session`（HttpOnly, SameSite=Lax）。https のときは `__Host-tkb_session`（Secure, Path=/, Domain無し）。DBには sha256(token) のみ。
- `csrfToken` は login と `GET /api/v1/auth/me` が返す。POST/PUT/PATCH/DELETE は `x-csrf-token` ヘッダー必須（loginを除く）。Originがある場合は PUBLIC_ORIGIN（未設定時は localhost:5173 系）のみ許可。
- 利用者は招待制: ``read -rs TKB_NEW_PASSWORD; export TKB_NEW_PASSWORD; npm run user:create -- --login demo-a --name "デモA"`（パスワードは引数に渡さない。環境変数なしで端末から実行すると非エコーで対話入力。loginIdは小文字に正規化）。

## ルートで使う

```ts
// buildApp 内（registerAuth の後）。app.authenticate が未ログインを 401 にする。
app.get('/api/v1/trips', { preHandler: app.authenticate }, async (req) => {
  const { userId } = requireActor(req); // import { requireActor } from '../auth/index.ts'
  return listTrips(db, userId);
});
```

- ownerId / userId は常に `requireActor(req)` から取る。リクエストボディ・クエリの値を信用しない（`insertTrip` の ownerId 引数にも ActorContext の値）。
- 他人のデータは存在を漏らさないため 404 を返す（K23）。
- パスワード・セッションtoken・cookie を log / 例外 / レスポンスに入れない。
- SameSite=Lax のため GET では状態変更しない（変更は POST/PUT/PATCH/DELETE のみ。CSRF検査の対象外になる）。
- `/api/v1/` 配下のルートは `app.authenticate` が無いと起動時にエラー（公開は health / capabilities / auth/login のみ）。
- 同一loginIdは15分5回、同一IPは15分50回の失敗で429（試行は検証前に計上し、成功時に取り消す＝並列試行で回避できない）。メモリ内（loginId単位とIP単位、15分で5回失敗→429）。Tunnel等でこの端末のプロキシ経由にする場合は `TRUST_PROXY=loopback` を設定する。`true` は X-Forwarded-For を偽装されIP制限を回避されるため禁止（設定は loopback のみ受理）。
