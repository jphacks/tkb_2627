# 共有デモの公開手順 (O01)

公開するのは共有サーバー（127.0.0.1:4310）だけです。共有サーバーが `apps/web/dist` を同一オリジンで配信するため、Webとの公開入口は1つです。

## 公開構成

```
ブラウザ → HTTPS → Cloudflare Quick Tunnel → 127.0.0.1:4310（共有サーバー: Web静的配信 + /api/v1/*）
```

公開しないもの:

- 本人用AI（4311、`/local/v1/*`、生成処理、Claude認証、`ALLOW_CLAUDE_EXECUTION`）
- DB（`data/travel.sqlite`）と `.env`
- GitHub認証（`gh` の資格情報）
- 開発用Vite（5173）、開発者用管理画面
- 共有サーバーは `child_process` と `@tkb/ai` を使わず、`/local/` で始まるパスは常に404を返します。公開URLへ生成要求を送ってもCLI子プロセスは起動しません。

## 手順（人間が実行する）

1. `npm run build` でWebを作る。
2. 人間が `cloudflared tunnel --url http://127.0.0.1:4310` を起動し、表示された https のURLを控える。共有サーバーの起動前は 502 になるだけで、安全。
3. `.env` に次を設定する。
   - `PUBLIC_ORIGIN`: 手順2で表示されたURL（末尾スラッシュなし）。
   - `SESSION_SECRET`: 32文字以上のランダム値（例: `openssl rand -hex 32`）。
   - `TRUST_PROXY=loopback`
   - `SHARED_BIND=127.0.0.1`、`PROVIDER_MODE=fixture`、`SHARED_PORT` は 4310（4311 / 5173 は不可）
4. `npm run serve:demo` で起動前検査を行う。検査だけで、何も起動しない。問題があれば理由を出して終了コード1になる。
5. `npm run start:shared` で共有サーバーを起動する。
6. 利用者は招待制で作る: `read -rs TKB_NEW_PASSWORD; export TKB_NEW_PASSWORD; npm run user:create -- --login demo-a --name "デモA"`。その後、下の確認チェックリストを行う。
7. 停止: 共有サーバーと Tunnel を Ctrl+C で止める。止めればURLは使えなくなる。

## 注意

- Quick Tunnel のURLは起動ごとに変わる。変わるたびに `PUBLIC_ORIGIN` を更新して共有サーバーを再起動する（Origin検査とcookie名 `__Host-` に影響する）。
- このPCが止まる、スリープする、Tunnelが切れると使えない。
- Tunnelは本人の端末から外へ向けた接続のため、`cloudflared` は人間が内容を確認してから起動する。

## 確認チェックリスト

- [ ] 公開URLの `/` がログイン画面（Web）を返す。
- [ ] 公開URLの `/api/v1/health` が200。
- [ ] 公開URLの `/local/*` と `/LOCAL/*`（例: `/local/v1/capabilities`）が404。
- [ ] `/api/v1/capabilities` が `aiGeneration.available=false`（`SHARED_ENTRY_NO_PERSONAL_CLAUDE`）。
- [ ] 生成エンドポイントが存在しない（共有サーバーに生成ルートが無い）。
- [ ] 非公開の投稿が別ユーザーから404になる（SNS投稿は S05 以降で未実装。実装後に確認する）。
- [ ] 保存を公開URLで確認する（旅程の共有保存は S01/S03 までの機能。SNS投稿は未実装）。

自動検査: `apps/server/test/static.test.ts`（静的配信、トラバーサル、ヘッダー）、`apps/server/test/exposure.test.ts`（ルート列挙、子プロセス不使用、起動前検査）。
