# 画面レビューのやり方

各画面を開いて触り、気になる点をその画面のIssueにコメントする。

## 手順

1. `git pull` してから `npm run review`
2. 表示されたURLを開く（スマホは同じWi‑Fiなら「スマホで開く」のURL）
3. 画面左下の帯のリンクからIssueを開き、「UI承認：OK」か「UI承認：要修正」と書く（要修正は箇条書きで理由）

## 確認する画面

| 番号 | 画面 | Issue |
|---|---|---|
| U03 | 条件入力 | https://github.com/jphacks/tkb_2627/issues/31 |
| U04 | 地図と旅程 | https://github.com/jphacks/tkb_2627/issues/32 |
| U05 | 計画の進捗と候補 | https://github.com/jphacks/tkb_2627/issues/33 |
| U06 | 編集・旅行中 | https://github.com/jphacks/tkb_2627/issues/34 |
| U07 | ガイド | https://github.com/jphacks/tkb_2627/issues/35 |
| U08 | SNS・グループ | https://github.com/jphacks/tkb_2627/issues/36 |

画面の一覧はホーム画面の一番下「UI確認用：全画面の一覧」にもある。

## 困ったとき

- ポートが使用中 → 自動で別のポートを使う。表示されたURLを開く
- スマホで開けない → PCと同じWi‑Fiか確認する。だめならPCで確認する
- 何か壊れた → `.local/review` を消してもう一度 `npm run review`
