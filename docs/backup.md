# バックアップと復元（O02 / R25）

共有サーバーの SQLite（`DATABASE_PATH`、既定 `data/travel.sqlite`）を、WAL を含めて一貫した1ファイルに保存し、別の空DBへ復元する手順です。

## いつ取るか

- デモの前
- 公開（外部への展開、招待の発行）の前
- migration を適用する前、サーバーを更新する前

## バックアップ

```
npm run db:backup
```

- 出力先は `backups/travel-<UTC時刻>.sqlite` です（リポジトリルート基準）。`backups/` は Git の追跡対象外です。
- 出力先を変える場合は `npm run db:backup -- --out <file>` とします。既存ファイルは上書きしません。
- サーバーを動かしたまま実行できます。内部では `VACUUM INTO` を使い、`-wal` にある未チェックポイントの書込みも含めた一貫したスナップショットを作ります。`.sqlite` ファイルだけを `cp` すると WAL の内容が抜けるので、`cp` は使いません。
- 完了時に `integrity_check`、適用済み migration、表ごとの行数を表示します。内容や秘密は表示しません。
- ファイルは 0600 で作ります。出力先ディレクトリを新規に作る場合は 0700 です。既存のディレクトリの権限は変更せず、0700 でなければ警告を表示します。出力先が切れたシンボリックリンクの場合も拒否します。
- 本体ファイル（`.sqlite`）だけをコピーしても、`-wal` にある直近の書込みが失われます。必ず `db:backup` を使います。

## 保存場所と取り扱い

- バックアップには個人情報に加え、パスワードハッシュ、セッションハッシュ、招待トークンのハッシュが入っています。
- Git に入れません。共有ドライブ、チャット、メールへ置きません。公開もしません。
- 保管はこの端末のローカル、または暗号化した個人用ストレージに限ります。不要になったら削除します。

## 復元

```
npm run db:restore -- backups/travel-<時刻>.sqlite --to data/restored.sqlite
```

- 復元先は新しいパスだけを受け付けます。`--to` が既存ファイル（`-wal`、`-shm` を含む）なら拒否します。稼働中の `DATABASE_PATH` も拒否します。
- 手順は、バックアップの `integrity_check`、コピー、復元先の `integrity_check`、未適用 migration の適用、行数の表示です。
- 失敗した場合、作りかけの復元先は削除します。バックアップが壊れていれば integrity エラーで止まります。

## 本番DBの差し替え（手動）

自動化していません。次の順に行います。

1. 共有サーバー（`npm run dev:shared` または `start:shared`）を停止する。
2. 停止中のまま、バックアップを別名のファイルへ復元する。`npm run db:restore -- backups/travel-<時刻>.sqlite --to data/restored.sqlite`（`--to` を稼働DBのパスにすることは拒否される）。表示された件数を確認する。
3. 稼働DBを退避する。本体、`-wal`、`-shm` は同じ新ベース名で揃える（削除しない）。
   ```
   mv data/travel.sqlite     data/travel.old-<時刻>.sqlite
   mv data/travel.sqlite-wal data/travel.old-<時刻>.sqlite-wal   # 存在する場合
   mv data/travel.sqlite-shm data/travel.old-<時刻>.sqlite-shm   # 存在する場合
   ```
   本体だけを退避して `-wal` を残すと、古い `-wal` が復元したDBに適用されて壊れるおそれがある。
4. 復元したDBを置く。`mv data/restored.sqlite data/travel.sqlite`
5. サーバーを起動し、ログインと旅程一覧を確認する。
6. 問題があれば、サーバーを止めて `data/travel.sqlite` を別名へ退避し、手順3で退避した3ファイルを同じ組み合わせで元の名前へ戻す。

## 検証方法

自動テスト（`packages/db/test/backup.test.ts`）は、利用者、グループ、所属、旅程（版2）、旅程の版履歴、投稿（public、group、private）、preview、招待を作り、WAL に未チェックポイントの書込みが残った状態でバックアップします。空のパスへ復元し、全表の行が同一であることと、閲覧者ごとの投稿の可視性が元と同じであることを確認します。

手元のDBで確認するときは、バックアップ時と復元時に表示される行数が一致することを見ます。実データを使うときは、復元先を `data/` の外の一時ディレクトリにして、確認後に削除します。
