# 画面（UI）の確認手順

手順と画面ごとのIssueは、リポジトリ直下の [REVIEW.md](../../REVIEW.md) にまとめている。

1. `git pull` してから `npm run review`（初回は自動で準備する）
2. 表示されたURLをPCかスマホ（同じWi‑Fi）で開く
3. 画面左下の黒い帯「この画面：U04 地図と旅程」のリンクからIssueを開き、`UI承認：OK` または `UI承認：要修正` と箇条書きでコメントする

確認用のデータは見本（fixture）だけで、外部API・Claudeは使わない。
確認用のDBは `.local/review/` にあり、消せば初期状態に戻る。
