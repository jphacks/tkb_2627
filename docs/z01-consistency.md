# Z01 整合性確認（2026-10-25、origin/main時点）

Issue #54。図・契約・実装・計画の一致を、コードとファイルだけで確認した。`gh`が使えないため、Issue・PR・証拠の確認は含まない（末尾に人間の確認リストを置く）。

## 1. 確認したこと

| 対象 | 方法 | 結果 |
|---|---|---|
| `model/system.json`のnode `path`と`docs/02_ARCHITECTURE.md` | 各pathの存在確認、実ディレクトリとの突合 | 6件が実在せず・または不足。修正済み（2章） |
| `model/system.json`のedge | 端点がnodeに存在、`contract`がK01〜K23に存在、全nodeと全edgeがいずれかのviewに属する | 不一致なし |
| HTTPルート（`apps/server`、`apps/ai-local`） | `app.get/post/patch/delete`のgrepと`docs/03_CONTRACTS.md`の突合 | docsに無いルート11件、docsの記述が誤り1件。修正済み（3章） |
| `Activity.parentActivityId` | `packages/contracts/src/trip.ts`とdocs/03の突合 | docs/03の互換追加に記載なし。追記済み |
| `ops/tasks.json` | R01〜R30の担当タスク、dependsOnの循環、未定義の依存先、owner | 全要件に1つ以上のタスクあり、循環なし、依存先の欠落なし |
| writePaths | 存在確認 | 5件が未作成（4章） |

## 2. node pathの修正（`model/system.json`と`docs/02`を同じ文言で更新）

| node | 修正前 | 修正後 | 理由 |
|---|---|---|---|
| gate | `apps/ai-local/src/routes/` | `apps/ai-local/src/app.ts, apps/ai-local/src/auth/` | routesディレクトリは存在しない。Host・Origin・CSRF・ペアリングは`app.ts`と`auth/` |
| auth | `apps/server/src/auth/` | `apps/server/src/platform/auth/` | 実装は`platform/auth` |
| groups | `apps/server/src/groups/` | `apps/server/src/social/groups/` | 実装は`social/groups` |
| web-local / web-shared | `apps/web/` | 画面は`src/screens/`と明記（共有版は`conditions, generate, itinerary, edit, social, guide, travel, print, hub`） | 画面の置き場を示すため |
| data-api | `packages/travel-data/` | `places, routes, guides, amenities, policy`と、公開API`apps/server/src/guides/`を追記 | guidesとamenitiesの公開ルートはサーバー側にある |
| exports | `packages/exports/, apps/server/src/platform/exports/` | `src/calendar`、`src/maps`、`calendar-maps.ts`を追記 | E03の実装場所を明記 |
| social | `apps/server/src/social/` | `posts, copy, groups`を追記 | 実際の構成 |
| trips | `apps/server/src/trips/` | `generation, alternatives, replan`を追記（detailにA05・A06の場所） | 実際の構成 |

変更なし（実在を確認）：personal、shared、job、shared-client、claude-adapter、validator、repository。`db`の`data/travel.sqlite`は実行時に生成するファイルでGit管理外（`DATABASE_PATH`既定値）。`cli`はOSにインストールされた公式CLIで、リポジトリ内のpathはない。

## 3. HTTPルートとdocs/03の突合

稼働ルートは、共有サーバー32、本人用App Server8（`/local/v1/pair`は`PAIR_PATH`定数で登録）。

| 区分 | ルート | 対応 |
|---|---|---|
| docsに無かった | `POST /api/v1/planning-context`（K05）、`POST /api/v1/trips/{id}/alternatives`（A05）、`POST /api/v1/trips/{id}/replan`（A06）、`POST /api/v1/trips/{id}/exports`、`GET`・`DELETE /api/v1/exports/{id}`、`GET /api/v1/trips/{id}/ics`、`GET /api/v1/trips/{id}/maps-links`（K18）、`GET /api/v1/guides`、`GET /api/v1/amenities`（K19） | 「実装で確定した事項」冒頭の稼働ルート一覧に追記。各ルートはK節・拡張節には既に記載があった |
| docsが誤っていた | 「`GET /api/v1/guides`は登録していません」 | `apps/server/src/guides/spots.ts`で登録済み。仕様と状態コードを記載 |
| docsにあり実装に無い | なし | |
| 追記漏れ | `Activity.parentActivityId` | 「互換の追加」に追記（1階層、親は同日、K07が入れ子を検証、ICS・Mapsは経由地にしない） |

## 4. 残る差異と未実装（隠さず記録）

| 項目 | 状態 | 備考 |
|---|---|---|
| 周辺施設（K19 amenities） | 常にfixture | `LiveAmenitiesProvider`は未接続のプレースホルダーで、`registerGuides`の既定はfixture提供元。`PROVIDER_MODE=live`でも切り替わらない。公式の避難所データは未接続。docs/03に「現状の差」として追記 |
| スポット説明（K19 guides） | fixtureの実在スポット・エリアだけ | liveはWikipedia。許可リスト外のplaceIdは200・空・`unknown` |
| 本人用App Serverのcapabilities | `dataMode=fixture`固定 | docs/03に既知の差として記載済み（A05で修正予定とあり、未確認） |
| システム図のedge | K02、K09、K10、K12、K15、K16、K19、K21、K22、K23を表すedgeが無い | 1つのedgeに1つの契約しか持てないため、K節の入出力は`docs/03`が正本。図で追う場合は同じ線上の親契約（K01、K14、K18、K20）を見る |
| writePathsが未作成 | G01 `.local/team.json`、G02 `dashboard/`、U02 `docs/ui-review/`（実際は`docs/ui/reviews/`）、E01 `packages/exports/src/templates/`（実際はPDF HTMLを`apps/server/src/platform/exports/`と`apps/web/src/screens/print/`に置いた）、Z02 `docs/release-report.md` | `ops/tasks.json`は今回変更していない。U02とE01のwritePathsは実態に合わせてM1が更新を判断する |
| ブラウザ保存 | 未確認 | 旅程・SNSの正本がサーバーDBであることは、ルートの存在までは確認したが、web側の保存先の全数確認はしていない |
| 図の再生成 | 実施 | `python3 scripts/build-figures.py`、`npm run guide`を実行（`assets/`、HTMLが更新される） |

## 5. 人間が`gh`で確認する項目

| 確認 | 対象 |
|---|---|
| 閉じたIssueに証拠（PR、実行テスト、画面URL）があること | `status:done`または閉じた全Issue。特に#54の完了条件「閉じたIssueに証拠あり」 |
| 人間の操作が必要なタスクの状態 | G01（招待）、U02（UI初回レビュー）、T07（ユーザー提供ケースの受入確認） |
| 画面レビューのIssue（U04 #32、U03 #31、U05 #33、U06 #34、U07 #35、U08 #36、E01 #37）に人間の承認コメントがあること | CLAUDE.md 8章の分担 |
| Z01の完了確定とmerge | M1 |
| 進捗HTMLの更新 | merge後に`npm run progress`（`gh`が必要） |
