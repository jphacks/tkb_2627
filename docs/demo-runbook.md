# デモ手順書（Z02 草稿）

状態：**草稿（2026-10-25）**。コマンドと画面の入口はmainのコードから書き起こしましたが、通しの実機リハーサルは未実施です。リハーサルで差が出たら、この文書を直します。

**【人間】** と付けた項目は、本人の操作や判断が必要です。Agentは実行しません。

## 1. 前提

- Node.js 22.13以上。
- このリポジトリのルートで作業する（`git rev-parse --show-toplevel`で確認）。
- 生成デモ（実際のClaude）は、**M4のPCだけ**で動きます。本人のClaude連携は他のPCに移せず、共有サーバーからも起動しません。他のPCでは、生成はmockまたは保存済みの旅程で見せます。**【人間】**
- 旅行データは既定でfixtureです。実際のGoogle Places/Routesを使う場合は、サーバーキーと課金上限の確認が必要です（docs/provider-probe.md、docs/08_POLICY_AND_COST.md）。**【人間】**

## 2. 準備

```bash
npm ci
cp .env.example .env     # .envはGitに入れない
```

`.env`で決めること：

- `SESSION_SECRET`：`openssl rand -hex 32`の出力など。
- `PROVIDER_MODE=fixture`（既定）。`mixed`にする場合は`GOOGLE_MAPS_SERVER_KEY`が必要。**【人間】**
- 公開URLで見せる場合だけ、`PUBLIC_ORIGIN`と`TRUST_PROXY=loopback`（docs/deployment.md）。

DBを作り、利用者を2人作ります。

```bash
npm run db:migrate
read -rs TKB_NEW_PASSWORD; export TKB_NEW_PASSWORD
npm run user:create -- --login demo-a --name "デモA"
read -rs TKB_NEW_PASSWORD; export TKB_NEW_PASSWORD
npm run user:create -- --login demo-b --name "デモB"
```

パスワードは各自で決め、チャットやGitに書きません。**【人間】**

## 3. 起動

どちらか一方を使います。

- 開発構成（共有サーバー4310、本人用4311、Web 5173を同時に起動）：`npm run dev`。ブラウザは`http://127.0.0.1:5173/`。
- 共有サーバー中心の構成：`npm run build`のあと`npm run start:shared`。Webも`http://127.0.0.1:4310/`で配信される。本人用の生成を使う場合は別端末で`npm run start:local`（M4のPC）。

起動後、`http://127.0.0.1:4310/api/v1/health`が200を返すことを確認します。

## 4. デモ用の旅程を用意する

デモの直前に慌てないよう、事前に1本作っておきます。

1. `#generate`を開く。画面の上部に、データの表示モード（mock／live）が出る。
2. 条件を入れて生成し、候補を比較して採用する（採用でサーバーに旅程が保存される）。
3. 採用後に地図の画面（`#/trips/<id>/map`）へ進めることを確認し、URLの`<id>`を控える。

mockモードで作った旅程はブラウザ内のデータで、共有DBには保存されません。以降の手順（編集、しおり、SNS）は、サーバーモードで保存された旅程が前提です。サーバーモードで生成できない環境（M4のPC以外）では、デモ用の旅程を事前にM4のPCで作り、同じDBを使う（`docs/backup.md`の復元）か、mockの画面で見せます。**【人間】**

## 5. デモの流れ（クリック経路）

`http://127.0.0.1:5173/`（または4310）を`demo-a`でログインして開き、`#home`から進みます。

1. **計画**：ハブから条件入力へ（`#conditions`／`#generate`）。行き先・日程・交通手段を入れる。
2. **候補**：生成の進捗のあと、候補を比較する。費用や所要時間が不明な項目は「不明」と表示されることを説明する。
3. **採用**：1つ採用する。
4. **地図**：`#/trips/<id>/map`。日ごとの経路と予定の同期を見せる。
5. **編集**：`#/trips/<id>/edit`。予定の入れ替えや時刻の変更、差分の確認。
6. **旅行中**：`#/trips/<id>/travel`。次の予定と、必要なら残りの1日分の組み直し。
7. **ガイド**：`#/trips/<id>/guide`。トイレ・避難所の表示。
8. **しおり／PDF**：`#/trips/<id>/print`で印刷画面を見せる。PDFは出力から取得する。
9. **SNS投稿**：`#social`で旅程を投稿する（公開範囲を選ぶ）。
10. **別ユーザーで閲覧・コピー**：別のブラウザ（またはシークレットウィンドウ）で`demo-b`でログインし、`#social`のフィードで投稿を開いてコピーする。コピー後の旅程が`demo-b`の一覧に出ることを確認する。

## 6. 何がfixtureで、何がliveか（審査では正直に話す）

| 項目 | 状態 | 話し方 |
|---|---|---|
| 旅程の保存、SNS、グループ、PDF | 共有サーバーの実機能 | 共通DBに保存されている |
| 地点・経路・運賃 | 既定はfixture。liveは限られた条件のみ確認 | 「デモのデータは固定の見本。実際のAPI接続は限定的に確認」 |
| Claudeによる生成 | M4のPCで本人のClaudeを使ったときだけlive | 「生成は本人のClaude連携。公開URLの第三者には提供しない」 |
| トイレ・避難所 | fixture。実データ取得は未実装 | 「指定されている施設の見本。現在開設中かは示さない」 |
| 観光解説と写真 | Wikipedia＋Commons（ライセンス確認つき） | 出典とライセンスを画面で見せる |
| 運賃・ホーム・営業時間・災害情報 | 不明なら「不明」と表示 | 推測で補っていない |

分からない値を口頭でも補いません。

## 7. 再起動と復旧

- 画面が動かない：まず`/api/v1/health`を確認する。次に、サーバーのログのエラーを確認する。
- サーバーを止める：Ctrl+C。再起動は`npm run dev`または`npm run start:shared`。DBは残る。
- PDF出力は、サーバーのメモリ上に10分だけ置かれます。再起動すると消えるので、もう一度出力する。
- 生成中のjobは、本人用サーバーの再起動で失敗します。同じ条件で再送する（保存済みなら重複しない）。
- ログインできない：`npm run user:create`で作り直す（パスワードは再設定が必要）。
- DBが壊れた：`docs/backup.md`の復元手順で、別パスに復元して差し替える。**【人間】**

## 8. バックアップ

デモの前に必ず取ります（docs/backup.md）。

```bash
npm run db:backup
```

`backups/`の中身は個人情報を含むので、Gitや共有ドライブに置きません。

## 9. 公開トンネルの停止

公開URL（Cloudflare Quick Tunnel）でデモをした場合は、終了後にトンネルと共有サーバーをCtrl+Cで止めます（docs/deployment.md）。止めればURLは使えなくなります。止めたあと、公開URLが応答しないことを外部のブラウザで確認します。**【人間】**

## 10. デモ前チェックリスト

- [ ] `git status`で意図しない変更がなく、mainが最新である
- [ ] `npm ci`と`npm run db:migrate`が通る
- [ ] `npm run check && npm run lint && npm test`が通る（任意で`npm run test:all`）
- [ ] `.env`にキーとSESSION_SECRETがあり、Gitに入っていない（`npm run check:secrets`）
- [ ] 利用者`demo-a`と`demo-b`でログインできる **【人間】**
- [ ] デモ用の旅程が1本あり、IDを控えた
- [ ] 通しのクリック経路を、本番と同じPC・ブラウザで1回通した **【人間】**
- [ ] Claude生成を見せる場合：M4のPCで、本人のClaude認証とAPI課金系の環境変数が無いことを確認した（docs/claude-connection-check.md） **【人間】**
- [ ] liveのGoogle APIを使う場合：呼出し回数と課金上限の承認を確認した **【人間】**
- [ ] `npm run db:backup`を取った
- [ ] 公開する場合：docs/deployment.mdの確認チェックリストを通し、終了後にトンネルを止める手順を決めた **【人間】**
- [ ] 不明な運賃・営業時間・災害情報を補って話さないことを、発表者が確認した **【人間】**
