# @tkb/db

共有サーバー専用のSQLite層（`node:sqlite`）。`apps/ai-local` からは開かない。

## 開き方
```ts
import { openDatabase, migrate } from '@tkb/db';
const db = openDatabase(process.env.DATABASE_PATH ?? './data/travel.sqlite');
migrate(db);
```
`openDatabase` は WAL、`foreign_keys=ON`、`busy_timeout=5000` を設定する。CLI: `npm run db:migrate`（`.env` はリポジトリルートから読む）。

## DBファイルの場所
`data/travel.sqlite`（`-wal` / `-shm` を含む）。`data/` と `*.sqlite*` は `.gitignore` 済みで、Gitに含めない。バックアップは O02 で扱う。

## migration規則
- `src/migrations/NNN_name.sql` を連番で追加する。適用順は名前順。
- `001_init.sql` を含む適用済みファイルは編集禁止（各PCに適用済みの可能性がある）。変更は新しい `NNN_*.sql` で行う。
- 各migrationは `BEGIN IMMEDIATE` 内で適用され、失敗時はrollbackされる。版は `schema_migrations` に記録される。

## transaction規則
- 書込みは `transaction(db, fn)`（`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`）で行う。入れ子は禁止。
- `fn` は同期で短く保つ。AI・外部API・ネットワークの待ちを中に入れない（書込みlockを保持するため）。
- SQLは prepared statement のみ。文字列連結でSQLを組み立てない。
- 旅程の更新は `updateTripWithRevision(db, trip, expectedRevision)`。古い版は `REVISION_CONFLICT`（`currentRevision` 付き）、他人・削除済みは `NOT_FOUND`（存在を漏らさない）。
- `createUser` は `passwordHash` のみ受け取る。平文パスワードは渡さない。

## S04（旅程API）で使うときの注意
- `insertTrip(db, ownerId, trip, now)`と`updateTripWithRevision(db, ownerId, trip, expectedRevision, now)`のownerIdは、必ずセッションから渡します。`trip.ownerId`、`createdAt`、`updatedAt`は無視され、サーバー時刻`now`が使われます。
- tripIdはサーバーで生成します。クライアント指定のIDを受けると、PK違反のエラーで他人の旅程の存在が漏れます。
- `NOT_FOUND`はK10の404、`REVISION_CONFLICT`は409に変換します。`expectedRevision`は、ここへ渡す前に422として検証します。
- `validationState`は呼び出し側の値がそのまま保存されます。保存前にサーバー側で再計算してください。
- `DatabaseSync`は同期APIです。lock待ち（最大でbusy_timeoutの5秒）の間はイベントループが止まるので、transactionは短く保ちます。
- 保存済みJSONが壊れていると、`getTripForOwner`が例外を投げます。API層では500 INTERNALとして返し、内容をログやレスポンスに出しません。
- `DATABASE_PATH`の相対パスは、サーバーでもCLIでもリポジトリルートを基準に解決されます。
