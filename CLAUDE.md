# tkb_2627 — JPHacks旅行Webアプリ・プロジェクト規則 v5

## 1. プロジェクトの場所
- **このGitルートそのものが`tkb_2627`**。全員が既存GitHub repoへのorigin接続を各PCで済ませている。
- `git clone`や`git init`、新しいGitHub repoを作る操作は行わない。`pwd`・`git rev-parse --show-toplevel`・`git remote get-url origin`で一致を確認する。違えば停止して本人に報告する。
- 同名repoを別フォルダへ再cloneして作業の分断を作らない。Worktreeは担当タスクの隔離に限って使用。
- 既存履歴、README、大会ファイル、未commit変更を破棄しない。

## 2. 不変条件
- 旅程生成AIは本人のClaude Code連携という構想。Ollamaへ勝手に切り替えない。公開第三者の要求を開発者Pro枠に中継しない。認証・利用条件を明確に確認し、安全に実装できない機能はblockedにする。API課金を無断で開始しない。
- 旅程/SNSは共通サーバーDB。ブラウザ保存を正本にしない。
- 国内外、公共交通・車、旅行前・旅行中、全30要件、UI早期試作、4人並列開発を維持する。
- 不明な運賃・駅のホーム・営業時間・災害情報を生成で補完しない。

## 3. 情報の正本と各自の読み方
- 正式な仕様は`docs/`と`model/`、入出力は`packages/contracts/`、全タスクは`ops/tasks.json`。
- 進捗・担当・blocked・引継ぎは**GitHub Issues**。変更提案・レビュー・統合はPRとCI。UIの承認は人間のIssueコメント。
- `docs/06_SETUP.md`に各自の開始方法、`docs/11_AGENT_DISPATCH.md`にAgent委任規則。
- `SYSTEM_DESIGN.html`は構成とデータ通信、`DEVELOPMENT_GUIDE.html`は開発方法。HTMLはGitHubのライブ更新ではなく取得時点の表示。
- Agentは作業開始時に自分のtask ID、依存先、許可パス、契約版だけを読み、全マスターを何度も読み込まない。

## 4. 人間メンバーと実装境界
| 担当 | 主な編集領域 | 初動 |
|---|---|---|
| M1 | `packages/contracts`, `packages/db`, `apps/server/src/auth`, `apps/server/src/social`, `.github`, 共有設定 | B01→B02/B03→G01/G02 |
| M2 | `apps/web`, `packages/exports`, `docs/ui` | B04→U01 |
| M3 | `packages/travel-data`, `packages/planner` | D01・D05 |
| M4 | `apps/ai-local`, `packages/ai`, `apps/server/src/trips` | A01＋A02（fake runner先行） |

M1は4人のGitHubのIssue担当・契約変更・mergeを調整する。各PCのメインClaude CodeはそのPCのサブAgentのみを管理できる。他PCや別アカウントのClaude Proを直接起動/操作しない。

## 5. Agentの明示的な利用ルール
**Agentを定義しただけで自動実行できたと見なさない。** メインが対象Issueを確認して該当Agentを明示的に選ぶ。必要なら@でAgentを明示選択する。利用可能なClaude Codeの`Agent` toolで`subagent_type`を指定。適切に動かなければ記録してメイン処理へ戻し、動いていないAgentを実行済みと報告しない。

| 作業フェーズ | 指名するAgent | モデルの既定 |
|---|---|---|
| 重要な契約・DB変更前 | `architect` | inherit |
| TypeScriptやAPI/SNS/Claude接続の実装 | `implementer` | sonnet |
| UI試作・画面改善 | `ui-builder` | sonnet |
| 独立テスト・異常系 | `test-author` | sonnet |
| PR前に必ず実施する別コンテキストレビュー | `reviewer` | inherit |
| PR前の仕様/C4/README/契約の差分照合 | `doc-checker` | haiku |

ワークフロー：Issue読み取り→（必要ならarchitect）→implementer/ui-builder→test-authorとテスト→reviewer→doc-checker→**メインが**commit/push/PR/報告。Agentへの指示は`taskId, writePaths, contractSha, acceptance, testCommand`を必ず含める。サブAgentにmerge・Issue完了確定・GitHub招待等の権限操作を委譲しない。

## 6. Gitフローと小刻みな保存
- default branchと状態を毎回確認し、担当ごとに`feat/m2/u01-short-slug`等の作業ブランチ。
- 単位テストと変更パスを確認してcommitし、**作業ブランチへ**小さくpush。15〜30分以上かかる作業はチェックポイントを残す。
- PR、独立レビュー、CIと実際の受入結果を揃え、統合担当M1がmergeしてdoneを確定。保護ルールの無断解除、force push、未reviewのmain書込みは禁止。
- UIが未確定でもfixtureと共通schemaで内部機能を開発する。同じパスを2つのworktreeで同時編集しない。
- 秘密情報・個人情報・DB・Claude認証情報をGitへ入れない。

## 7. 人間への短い報告
実行したことと予定を区別し、`タスク / 担当 / branch / PR / 実行テストと結果 / 画面URL / blocker / 次の操作`を短く報告。未確認の外部権限・API課金・招待は本人の操作を待つ。

## 8. 締切前の運用（2026-10-25 15:00 JST 締切）
- **手を止めない**：自分のタスクが依存待ちになったら、`DEVELOPMENT_GUIDE.html`の「タスクグラフと担当」で着手可能（READY）なタスクを探し、他の人の担当でも、Issueに開始ログ（taskId、branch、writePaths）を1件書いて着手する。M1の承認を待たない。担当の組み直しは#121。
- **衝突を避ける**：`apps/web`は画面ごとのディレクトリ（`screens/conditions/`、`screens/itinerary/`、`screens/social/`など）に分け、他の人が開始ログを書いたディレクトリは編集しない。共通部品を変えたら、PR本文に明記する。
- **トークンを節約する（利用枠が厳しい）**：
  - Agentのモデルは定義どおりにする。実装（implementer）、UI（ui-builder）、テスト（test-author）は**sonnet**、差分照合（doc-checker）は**haiku**。**opus（inherit）は、architectと、共有の契約・DB・認証を変えるときのreviewerだけ**にする。
  - Agent toolを呼ぶときは、`model`を明示する（省略するとメインと同じ高いモデルになる）。
  - reviewerは1つのPRにつき1回。指摘を直した後の再レビューは、直した箇所だけを見せる。
  - マスタープロンプトやdocs全体を読み直さない。タスクID、依存先、writePaths、契約の該当節だけを読む。
  - テストは、まず変更した範囲だけを実行する（例：`npx vitest run apps/web`）。全体（`npm run test:all`）はPRの直前に1回だけ。
- **進捗を必ずGitHubに残す**：着手したら、Issueに開始ログ（taskId、branch、writePaths）を書き、`status:doing`にする。PRを出したら`status:review`にする。引継ぎは1コメントにまとめる。M1が進捗HTMLに反映する。
- **UIの要望は必ず守る**：UIを作る・直すときは、`docs/ui/reviews/`とIssueのレビューコメントを受入条件にする。
- **画面レビューは4人で分担する**（`npm run review`、`REVIEW.md`）：M1はU08 #36とE01 #37、M2はU04 #32とU06 #34、M3はU03 #31とU07 #35、M4はU05 #33。
- Claude Codeを起動すると、`.claude/settings.json`のSessionStartフックが、締切とこのルールを表示する。
