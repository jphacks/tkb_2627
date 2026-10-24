# tkb_2627 — Claude Code Subagentの実行規則（v5）

## 定義済みAgentと実際の指定
プロジェクトの`.claude/agents/`に6個の定義があり、全メンバーがGitから取得する。公式Claude Codeの`/agents`で読込結果を確認できる。Agentは各PCのClaude Pro認証で動作し、他のPCへ連携はしない。GitHub Issue/PRが4人間の連携手段になる。

| 入力されるIssueの種類 | Mainが起動するAgent | 期待される結果 | 次 |
|---|---|---|---|
| Schema・DB・認証・複数領域にまたがる変更 | architect (inherit) | 影響する契約、担当、変更順、危険箇所 | M1に契約変更を通知 |
| API/SNS/AI接続/バグ修正 | implementer (sonnet、worktree) | 変更ファイル、局所テスト、差分 | test-author |
| UI初案・操作・レイアウト調整 | ui-builder (sonnet、worktree) | 実画面、fixture/liveの区別、スクリーンサイズ検証 | 人間UIレビュー＋test-author |
| API・認可・日時・再計画などのテスト | test-author (sonnet、worktree) | テストコード、正常/異常ケース、実行結果 | reviewer |
| PR前の独立レビュー | reviewer (inherit、読取り専用) | blockingとoptionalの問題、根拠と再現方法 | 修正またはPR |
| 契約・機能仕様・図・READMEの差分照合 | doc-checker (haiku、読取り専用) | 古いパス、誤仕様、実装との矛盾 | 該当担当へ修正依頼 |

**特に重要**：Agentの`description`が自動委任の手掛かりにはなるが、必要なステップを必ず呼び出したい場合は**明示的にAgent名を指定**する。Claude CodeのAgent tool呼出しはCLI版やバージョンで違い得るため実環境を確認。CLIでは`@`から登録済みAgentを選ぶ手段がある。動かなければその事実を報告。

## タスク1件の標準手順
1. メインが`git fetch origin`・`gh issue view`・タスクJSONで依存先のmerge状態、担当を確認。
2. 開始ログ `taskId / branch / contractSha / writePaths / acceptance / testCommand` をIssueへ記録。
3. 複数領域へ影響するなら`architect`で変更案をレビュー。必要な共通型はM1経由の小さな先行PRへ。
4. UIなら`ui-builder`、他の実装なら`implementer`を指名。Worktreeに成果物が残るときはメインが`git status`とcommitを確認して安全に統合。未commitを消さない。
5. 実装に対応する検証を`test-author`へ依頼。ただし簡単な差分ではメインによる検証を許容し、その理由をIssueに残す。
6. 局所テストを実行し、`reviewer`を**必ず別コンテキスト**で起動。指摘のblockingを解消する。
7. `doc-checker`が仕様、C4通信、変更契約、README、タスクとの整合を点検。
8. メインが変更されたパスと秘密情報を確認し、commitと作業ブランチpush、PRを作成。
9. M1と人間が必要なレビュー/CI/手動UI承認を確認してからmergeし、GitHub IssueへSHAと完了証拠を残す。

## 分業と使用量の調整
全Agentを無条件に同時起動しない。Claude Proはアカウントごとの利用枠を消費する。独立した読み取りの`architect`・`reviewer`は、必要なときだけ実行。書込みAgentを並列にする場合は別のパスかworktreeを割り当てる。特に`packages/contracts`, root lockfile, migrationsはM1が書込み順序を調整。新しいAgent Teams機能はこの4人の接続手段ではない。

## 既定モデル
- `architect`: `inherit`。重要な構造判断のみメインが上位モデルを明示的に選ぶ。
- `implementer`, `ui-builder`, `test-author`: `sonnet`。
- `reviewer`: `inherit`。高リスクな認証・SNSの権限・Claude接続の審査ではメインの上位モデルを検討。
- `doc-checker`: `haiku`。

モデル指定は定義ファイルのfrontmatterで行う。CLIが実際に使えるモデル名・プラン制限を確認し、無断にAPIキー経由の従量課金へ切り替えない。

## M2用の具体的な委任例
Issue U01。まず`ui-builder`に次の情報を付けて依頼：対象`apps/web/`、採用済みTrip schemaのSHA、画面の受入条件、fixtureでの初期動作、スマホ幅の検証。次に`test-author`に表示と操作のE2E、最後に`reviewer`に差分と受入試験を渡す。契約変更が必要なら`architect`→M1の順に通知し、M2が勝手に共有Schemaを破壊しない。

## M4用の具体的な委任例
Issue A02。`implementer`で本人用Claude接続の**fake runner**から実装し、`test-author`でJSON不正・タイムアウト・取消・認証なしを検証。`reviewer`で外部公開と機密境界を確認。実Claudeへ接続するA01は公式利用条件と本人実機検証が完了したときだけ実装済みとする。公開利用者のAI要求を開発者のPro枠へ転送しない。
