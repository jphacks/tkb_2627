# 検討事項 v4

## 実行時に必要な情報
1. 既存GitHubのリポジトリ名はtkb_2627（確定）。未確認はOWNER名・default branch・所有者権限・3人の招待承認。
2. M1〜M4とGitHub loginの対応。氏名や認証を推測しない。
3. 各PCのOS、Git/Node/gh/Claudeの導入と版。ホストするPC、URL、公開相手。
4. 旅行情報サービスのキー、利用上限、取得地域、保存・表示・LLM入力可否。

## 開発を止めずに検証する項目
A01：公式CLIの非対話JSON出力と利用条件を実機確認。本人用途と第三者向け配布を区別。個人Proで公開ユーザーの依頼を中継する構成は作らない。未解決なら実生成をblockedにし、UI・SNS・保存・偽CLI試験を進める。代替モデル/APIへ勝手に変更しない。
D01：対象地域の経路・運賃等の実取得と規約。全世界の時刻・ホームが取得できるとは保証しない。
R18/R19：Maps URLとICSは初期設計。Googleの保存済みリスト/カレンダーへの自動書込みと同義ではない。元の自動登録要望との差分を残し、権限・手段を検証する。

## 人間が実物を見て判断
UIの画面別承認、代表ケースでの旅程品質、発表の操作順。初期から試作を提示し、未回答を承認にしない。

## B01 実施記録（2026-10-24、M1）
- Gitルート`tkb_2627`、origin `jphacks/tkb_2627`（public）、default branch `main`、M1の権限ADMIN。branch保護なし（PR運用は規則として守る）。
- 共同編集者：KatTanaka（M1）、murataka-csl（M2）、ryoumatimati（M3）、poyyk（M4）。対応はM1が本人確認。招待はすべて承認済み（admin）。
- M1端末：macOS arm64、16GiB、Node 24.19.0、npm 11.17、Python 3.9.6、gh認証済み、Claude Code 2.1.258、Graphviz 16.1（図生成用にHomebrewで導入）。cloudflared未導入（O01で必要）。
- M2〜M4端末のOS・ツール版は未確認。各自`npm run doctor`の結果を担当Issueへ記録する。
- このセッションでは`.claude/agents`の6定義はカスタムAgent型として未登録だった（起動後に配置したため）。Claude Codeを再起動すると`/agents`で読み込まれる。初回は汎用Agentに定義を渡して実行した。
- 外部認証・課金の阻害要因：Google等の旅行APIキー未提供（D01はblocked候補）、本人Claude CLIの非対話利用条件は未確認（A01、M4）。
