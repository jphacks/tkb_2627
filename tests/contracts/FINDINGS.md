# T01 FINDINGS (tests/contracts)

base: 33f2a02（main）+ 本タスクの文書・fixture修正。追加試験は vitest（`npm run test:unit`）で実行する。
実装（apps/**/src、packages/*/src）の不具合は見つからなかった。契約と実装の応答は、代表ルート全件で一致した。
`it.skip` は下表のモック差分のみ（8件）。いずれも skip を外すと理由どおりに失敗することを確認済み。M2 が U01 前に直し、直したら skip を外す。

## 文書・fixture の修正（M1 判断、実装どおりに揃えた）
- 完了した job の stage は `done`。fixtures `sampleJobStatuses.succeeded`、`model/contracts.json` K02 exampleOut、`docs/03_CONTRACTS.md` K02 戻り例を `done` にした。
- `docs/03_CONTRACTS.md`「実装で確定した事項」K21 に「成功済み（succeeded）の取消は200でstateとbatchIdを返す」を追記した。

## モックと実装の差分（apps/web/src/mocks/mockApi.ts、M2 担当）
| ID | 差分 | 実装（正） | モック | skip している試験 |
|---|---|---|---|---|
| M-1 | 完了 job の stage | `done` | `saved`（NORMAL_STEPS の最終段） | mock-vs-real "a succeeded job is at stage 'done'" |
| M-2 | K10 CONSTRAINT_UNSATISFIED の details | `{operationIndex, reason}` | `{op}` | "CONSTRAINT_UNSATISFIED details have the same keys" |
| M-3 | K10 warnings | 構造変更で needs_revalidation になると `移動情報を再確認してください` を追加 | 変更しない | "an itinerary edit adds the same re-check warning" |
| M-4 | K08 の422 | baseTripId 不一致は 422 VALIDATION_FAILED。invalid/needs_revalidation 候補は 422 CONSTRAINT_UNSATISFIED | どちらも適用してしまう（後者はモックに該当候補を持たせる必要もある） | "apply of a candidate onto a trip it was not generated for is 422" |
| M-5 | feed の cursor | base64url の不透明値 | 数字のオフセット文字列。実サーバーは 422 にする | "a cursor issued by the mock is a valid cursor for the real feed" |
| M-6 | K21 成功済みの取消 | 200 `{jobId, state:'succeeded', batchId}` | 409 ALREADY_COMMITTED | "cancel after success is 200" |
| M-7 | K01 replan と baseTripId | 422（A04 まで） | 受理して 404/409 | "replan and baseTripId are 422 on both until A04" |
| M-8 | VALIDATION_FAILED の details | なし（何が悪いかを返さない） | `details.issues` を付ける | "VALIDATION_FAILED carries no details on both" |

M-8 以外の比較（M-1〜M-7 以外の status・error code・details のキー・応答のキー）は一致している。M-8 のため、422 の比較は details を除いて行っている。
差分のうち mockApi.ts 冒頭に書かれているもの（M-4 の一部、M-5 周辺、M-6、M-7）は既知。M-1、M-2、M-3、M-8 は冒頭に書かれていない。
モックだけの既知の制約として、匿名の `scope=groups` が実サーバーは 401、モックは空の 200 になる（認可なし）。これは差分として固定した（skip ではなく通過する試験）。

## 契約が表現していないこと（試験で現状を固定した。直すかは M1 判断）
- C-1 通貨コード：`^[A-Z]{3}$` の形式だけを検査する。未割当の `ZZZ` と ISO の「通貨なし」`XXX` は受理される。コード表の検査が必要なら契約の変更になる。
- C-2 JSON Schema（`z.toJSONSchema`）は `endDate >= startDate`、`activityOrder` の重複なし、`replan` の必須項目を表現できない。CLI の出力は必ず Zod で再検証する（BlueprintParser）。出力側は `additionalProperties: false` と必須項目、`candidates` 1〜3件、`activityOrder` 1件以上を持つ。なお JSON Schema の試験が固定しているのは zod 4.6.7 の `z.toJSONSchema` 既定（`io: 'output'`）の挙動だけで、CLI が使う schema 生成関数は未実装（A04）。生成関数の新設は contracts の変更になるため、M1 が A04 前に判断する。
- C-3 `TimeZone` は Intl の判定なので `asia/tokyo` のような大文字小文字違いも受理する。`utc` は受理されない。保存前に正規化するかは未決。
- C-4 `ZonedTime.utc` が、その日付やゾーンと整合するかは検査しない。夏時間の隙間や日付またぎは planner 側の責務。
- C-5 `PlanBlueprint` の未知の placeId と重複 candidateId は、スキーマでは通る。BlueprintParser（allowedPlaceIds）が拒否する。
- C-6 `PlanBlueprint` は strict ではなく、未知キーを黙って落とす。CLI 側の JSON Schema が closed object なので、通常は混入しない。この「closed object」も上記の `z.toJSONSchema` 既定の挙動であり、A04 で生成関数を作るときに維持されるかを試験で確認する。
- C-7 `JobStatus` は `succeeded` かつ stage が `done` 以外の組を受理する（強制しているのは実装側 state.ts だけ）。M-1 の修正後に contracts へ refine を追加する予定。

現状固定の試験は、題名に `[FINDINGS C-n: 修正時は反転]` を付けた（C-1、C-3、C-6）。

## 担保の分担
- 本タスクで新規：契約と実装の一致（共有・本人用）、モックと実装の一致、AI の JSON Schema とブループリント拒否、値の境界、fixture と mockApi 全応答の一括検証。
- 既存に任せたもの：アクセス権限（tests/access）、漏えい・課金（tests/security）、job の異常系（tests/jobs）、CLI 境界（tests/ai）、fixture 個別の意味（packages/fixtures）、モック個別の挙動（apps/web/src/mocks）。
