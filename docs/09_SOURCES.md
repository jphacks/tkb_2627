# 公式資料

確認日 2026-10-23。引用ではなく設計の参照元。実機CLIの版と条件は別途照合。

## S01 C4の記法・方向付き関係
https://c4model.com/diagrams/notation
図の種類、対象範囲、要素の種類、責任、通信方式を記載する。

## S02 C4 Dynamic diagram
https://c4model.com/diagrams/dynamic
静的モデルの要素を使い、番号付きの往復をsequence styleで表示する。

## S03 C4 Code diagram
https://c4model.com/diagrams/code
重要な1コンポーネントを型・関数・テーブルまで掘り下げる。今回は実装前の設計図。

## S04 C4 Deployment diagram
https://c4model.com/diagrams/deployment
実行端末、プロセス、永続データ、公開境界を分ける。

## S05 Claude Code 非対話実行
https://code.claude.com/docs/en/headless
公式CLIの-pとJSON出力。通常モードはhooks等を読み得る。bareはサブスク認証を使わない。

## S06 Claude Code CLI reference
https://code.claude.com/docs/en/cli-reference
実機のhelpと認証方式を照合して使用可能なフラグを固定する。

## S07 Claude Code 法的条件
https://code.claude.com/docs/en/legal-and-compliance
第三者要求を開発者Proへ中継しない。本人利用・製品配布の適用条件を別々に確認する。

## S08 Claude Code Subagents
https://code.claude.com/docs/en/sub-agents
Agentごとの文脈と権限。利用枠は同じアカウントで消費する。

## S09 GitHub Issue dependencies
https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies
依存関係の共有。利用可能なghフラグは実機で確認する。

## S10 GitHub Projects
https://docs.github.com/en/issues/planning-and-tracking-with-projects
IssueとPRを表示する進捗ビュー。仕様やコードの正本にはしない。

## S11 Git worktree
https://git-scm.com/docs/git-worktree
同じ端末内で別ブランチの作業場所を分離する。別PC間の同期機能ではない。

## S12 Google Routes 公共交通
https://developers.google.com/maps/documentation/routes/transit-route
取得できる情報と中間地点の制約。区間ごとの出発時刻で検索する。

## S13 Google Places policies
https://developers.google.com/maps/documentation/places/web-service/policies
保存、帰属、表示の条件。外部生データの無条件転載をしない。

## S14 Cloudflare Quick Tunnels
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
一時公開用。公開先を共有サーバーだけに限定。実機の制約を確認する。
