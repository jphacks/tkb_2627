# サンプル（プロダクト名）

[![IMAGE ALT TEXT HERE](https://jphacks.com/wp-content/uploads/2026/07/IMG_5316.png)](https://www.youtube.com/watch?v=piaNsc6ilBI)

## 製品概要
### 背景(製品開発のきっかけ、課題等）
### 製品説明（具体的な製品の説明）
### 特長
#### 1. 特長1
#### 2. 特長2
#### 3. 特長3

### 解決出来ること
### 今後の展望
### 注力したこと（こだわり等）
* 
* 

## 開発技術
### 活用した技術
#### API・データ
* 
* 

#### フレームワーク・ライブラリ・モジュール
* 
* 

#### デバイス
* 
* 

### 独自技術
#### ハッカソンで開発した独自機能・技術
* 独自で開発したものの内容をこちらに記載してください
* 特に力を入れた部分をファイルリンク、またはcommit_idを記載してください。

---

## 開発者向け：tkb_2627 開発開始キット v5

**開発する本体のGitHub repository名と、各PCのGitルート名は`tkb_2627`です。** 4人とも既に各自のPCでGitHubのoriginへ接続済みの前提です。**新しいcloneやgit initは行いません。**

### まず人間が開くもの
- **`START_TKB_2627.html`**：フォルダの場所、配置手順、4人の開始、Agentの役割と指名方法。
- **`DEVELOPMENT_GUIDE.html`**：GitHub情報管理、14段階のrunbook、依存関係付き54タスク、4人の並列作業。
- **`SYSTEM_DESIGN.html`**：旅行アプリ本体のC4構造、旅程生成の入出力、SNS・認証・保存。

### M1だけが初回に行うこと
1. ZIPは**tkb_2627と同じ親ディレクトリ**に展開しておき、`tkb_2627`のGitルートへ移動。
2. `git rev-parse --show-toplevel`と`git remote get-url origin`を確認（末尾が`tkb_2627`）。
3. `node ../tkb_2627_bootstrap_v5/scripts/place-kit.mjs --target . --expect-repo tkb_2627`で**変更予定を表示**。
4. 問題なければ同じコマンドに`--apply`を追加。**既存のファイルは勝手に上書きしません。** 既存READMEなどの衝突時は、差分確認後に`--skip-conflicts`を明示して不足ファイルだけ追加可能（既存ファイルは保持）。スキップされたファイルはM1が内容を確認し、安全にマージしてから開発を開始。
5. `node scripts/check-repo.mjs`, `npm run check`, `npm test`で配布資料を検証。
6. `claude`を`tkb_2627`内で起動し、**`prompts/M1_START.txt`を読み、docs/11_AGENT_DISPATCH.mdのAgent委任規則に従ってB01から実装してください。** と指示。
7. M1が初期アプリ骨格を作って作業ブランチpush→PR統合、残り3人へ共有。

### M2〜M4は同じことをしない
M1が基点を統合してから、**各自の既存tkb_2627**で`git fetch origin`し、作業を汚さずに最新default branchを取得。`claude`を開いて各自の`prompts/M2_START.txt`等を読ませる。M2〜M4でキットを再配置しない。

### 実装前の成果物と区別
このキット自体が実行可能にするのは**設計の検査、HTML、GitHubタスク準備**だけ。旅行アプリ本体の`apps/`や`packages/`はM1の初回タスクから構築する。

### 検証コマンド
Node.js 22以降。`npm run check`, `npm test`, `npm run doctor`, `npm run guide`。図の再生成はPython3/Graphvizが必要。GitHub Issuesへの書込みは必ずdry-runの次に本人承認付きapply。

### Claudeと利用条件
旅程生成はClaudeを希望。本人用App Serverから公式Claude Codeに接続する実機・利用条件を最初に検証し、第三者によるPro枠の利用を公開しない。Ollamaや従量課金APIへ無断で切り替えない。本人用入口は外部公開せず、共有サーバーはDB/SNS閲覧・編集の権限管理を担う。

### 旅行アプリの起動
Node.js 22.13以降（推奨24）を使います。利用できるscriptは`npm run`で確認できます。

```bash
npm ci              # 依存の導入（lockfileどおり）
npm run setup       # data/ を作り、SQLiteのmigrationを適用
npm run dev         # 共有API :4310、本人用 :4311（127.0.0.1のみ）、Web http://127.0.0.1:5173
npm run test:all    # キット検査、秘密情報検査、lint、キットのテスト、型チェック、アプリの単体テスト
```

**利用者の作成（招待制）**：パスワードは引数ではなく、環境変数か非表示の入力で渡します。
```bash
read -rs TKB_NEW_PASSWORD; export TKB_NEW_PASSWORD
npm run user:create -- --login demo-a --name "デモA"
```

**本人用App Server（:4311）**：
1. `.env.ai-local`の`PERSONAL_OWNER_USER_ID`に、自分のアプリ利用者ID（`user_…`）を設定します。
2. 起動時に端末へ表示される一度限りのペアリングコードで、ブラウザと対応づけます（`POST /local/v1/pair`）。
3. 実際のClaude実行は、本人のPCで本人だけが行います（A01の結論、#25）。既定は`ALLOW_CLAUDE_EXECUTION=false`で、`true`にするには`CLAUDE_TERMS_ACK=true`も必要です。

**実装状況（2026-10-25時点）**：画面とAPIの多くが統合済みです。ただし「統合済み」はfixtureまたはmockでの動作確認を含みます。live（実際のClaudeや外部API）で確認できた範囲は、備考欄に分けて書いています。

状態の意味：統合済み（mainにあり、テストで確認）／fixtureのみ（実データ源につながっていない）／live確認済み（実際の外部サービスで確認した記録がある）／未実装。

| 機能 | 状態 | 備考 |
|---|---|---|
| 認証・グループ・招待（S02、S03、U08） | 統合済み | 招待制。招待リンクは`/invite#<token>` |
| SNS投稿・フィード・コピー（S05、S06、U08） | 統合済み | 2ユーザーの統合テストあり（tests/e2e/social） |
| 旅程API・版管理（S04）、編集・再計画（U06） | 統合済み | e2eあり（tests/e2e/replan） |
| 共有入口の公開準備（O01） | 統合済み | 公開の実施は人間が行う（docs/deployment.md） |
| 条件入力・生成・候補比較・採用（U03、U05） | 統合済み | mockモードとサーバーモードの両方。画面のデータ表示モードを明示 |
| Claudeによる実生成（A04） | live確認済み（M4のPCのみ） | 本人のClaude連携はM4のPCでだけ動く。共有サーバーからは起動しない。他のPCでは未確認 |
| 旅行データ：地点・経路（D03、D04） | fixture／一部live確認済み | 既定はfixture。Places・Routesのliveは限られた条件でだけ確認（docs/provider-probe.md）。`PROVIDER_MODE=mixed`/`live`はサーバーキーが必要。国内の公共交通など未確認の組合せがある |
| 地図と旅程の同期（U04） | 統合済み | 地図表示は地図キーが必要。キーなしでは使えない部分がある |
| 旅行中画面・次の予定（U06） | 統合済み | 旅行中の再計画は残り1日分まで（A06） |
| 現地ガイド・周辺施設（U07、K19 amenities、D08） | fixtureのみ | トイレ・避難所はfixture。liveの取得は未実装で、サーバーは503を返す。スポット説明のAPI（`GET /api/v1/guides`）は未登録 |
| 観光解説と写真（D07） | 統合済み（Wikipedia＋Commons） | 取得元はWikipediaとCommons。ライセンスを確認できない写真は使わない。画面への接続は未確認 |
| しおり印刷（E01） | 統合済み | ブラウザの印刷機能を使う |
| PDF出力（E02、K18） | 統合済み | 共有サーバー内で生成。地図画像と写真は含まない。ICS・Maps URLは`@tkb/exports`の関数のみで、画面とAPIからは未接続 |
| 画面の入口（ハブ） | 統合済み | `#home`が既定 |
| 統合テスト（I02〜I05、T02、T06） | 統合済み | liveの確認（T06）は手動実行。通常のテストはfixture |
| 災害情報の現在の開設状況 | 未実装 | 「指定されている施設」までを示し、現在開設中とは表示しない |

### 画面の入口

ブラウザで開くURLです（開発時は`http://127.0.0.1:5173/`、共有サーバー経由は`http://127.0.0.1:4310/`）。`<id>`は旅程のIDです。`#/mock/trips/<id>/…`はmockデータで開く版です。

| URL | 画面 |
|---|---|
| `/`（`#home`） | ハブ。旅程の一覧と各画面へのリンク（既定） |
| `#conditions` | 条件入力（U03） |
| `#generate` | 生成→進捗→候補比較→採用（U05） |
| `#/trips/<id>/map` | 地図と旅程（U04） |
| `#/trips/<id>/edit` | 旅程の編集（U06） |
| `#/trips/<id>/travel` | 旅行中の画面（U06） |
| `#/trips/<id>/guide` | 現地ガイド（U07） |
| `#/trips/<id>/print` | 写真付きしおりの印刷画面（E01） |
| `#social` | SNSとグループ（U08） |
| `/invite#<token>` | 招待リンクの受け取り（U08） |
| `#u01` | 初期のUI試作（mockのみ） |
| `#dev-shell` | 接続状態とfixtureビューア（開発用） |

デモの手順は`docs/demo-runbook.md`にあります。

詳細は`ops/tasks.json`とGitHub Issueで追跡しています。公開の手順は`docs/deployment.md`にあります。
