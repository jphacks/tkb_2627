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
