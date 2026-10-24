# @tkb/contracts — 共通入出力契約 schema v1

`docs/03_CONTRACTS.md`（K01〜K23）の実装です。Zod v4のスキーマと、そこから導出したTypeScript型を公開します。
Web・共有サーバー・本人用App Server・旅行データ・プランナーは、すべてこのパッケージから型をimportします。

| ファイル | 内容 | 主な契約 |
|---|---|---|
| `common.ts` | Id、LocalDate、UtcInstant、IANA TimeZone、ZonedTime、Money、DataStatus、Provenance | R07 |
| `trip.ts` | PlaceInfo、Activity、TravelLeg、TripDay、TripConstraints、Trip | K06、K09 |
| `generation.ts` | GenerateRequest、JobStatus、GenerationInput、PlanBlueprint | K01〜K03、K21 |
| `planning.ts` | PlanningContext、PlanBatch、ApplyCandidate、TripPatch | K05、K07、K08、K10 |
| `social.ts` | PostSnapshot、Preview、Post、Feed、Copy、Group | K12〜K17 |
| `platform.ts` | Login、Capabilities、Health、Export、Guide | K11、K18、K19、K22 |
| `errors.ts` | ErrorCode、ERROR_HTTP_STATUS、ApiError | K23 |

## 表現の決まり
- **未取得の値は`null`**にします。0、空文字、推定値で埋めません。由来は`dataStatus`（`verified | fixture | unknown | unavailable | unsupported_region`）で示します。
- **金額**は`{amountMinor: 整数, currency: ISO 4217}`です。
  - 費用と運賃は`NonNegativeMoney`、差額は`Money`を使います。
  - 合計は通貨ごとに分け、通貨をまたいで合算しません。
- **時刻**は`ZonedTime {utc: Z付きISO, timeZone: IANA}`です。現地時刻は表示時に導出します。
- **1日の行程**は`TripDay.items`の1配列で、予定（`type:'activity'`）と移動区間（`type:'leg'`）を時系列順に並べます。
  - `meal`は固定店舗への訪問、`free_walk`はエリア単位の自由散策です（R13）。
  - `fixed`は変更不可（予約など）、`status`は`planned | completed | skipped`で、両者は別の軸です（R12）。
- **SNSのsnapshot**は`PublicActivity`（公開してよい項目を`pick`で列挙したもの）だけで組み立てます。`privateNotes`は含まれません。
- **リクエスト**は`strictObject`で未知のキーを拒否します（例：K01に`ownerId`を入れられない）。応答・読出しのモデルは未知のキーを取り除きます。

## schemaVersion と変更手順
`SCHEMA_VERSION = 1` は、永続化文書（Trip、PlanBatch、PostSnapshot）とAIとのやり取り（GenerationInput、PlanBlueprint）、capabilitiesに付けます。

- **互換変更**（同じversionのまま）：任意フィールドの追加、新しいスキーマの追加。
- **破壊的変更**（versionを上げる）：フィールドの削除・改名・型変更・必須化、enum値の削除、意味の変更。

破壊的変更の手順（`docs/04_TEAM.md`）：
1. 変更したい担当が、契約変更Issueに「必要な値・例・必須か」を書き、M1をmentionします。
2. M1が`packages/contracts`の小さなPRを作ります。破壊的変更の場合はv2スキーマとDB内JSONの移行関数を同じPRに入れます。
3. 影響するM2/M3/M4がfixtureと変換処理をレビューします。
4. M1がmergeし、影響IssueへmergeのSHA・schemaVersion・移行方法を通知します。各担当はfetchして`npm run test:unit`を実行します。

`packages/contracts`はM1だけが編集順を調整する共有ファイルです。各担当は直接書き換えず、上記の手順で依頼してください。

## 資料間の食い違いの解決（B02、architectレビュー反映）
| 食い違い | v1での決定 |
|---|---|
| K03は`activityOrder`、K07は`activities` | 別の型として両方持つ。AIの出力は`CandidateBlueprint.activityOrder`（未検証）、保存する候補は`PlanCandidate.days`（検証後） |
| validationStateの値が`needs_review`と`needs_revalidation`で揺れている | 1つのenumに統一：`valid / needs_review / needs_revalidation / invalid` |
| F04は`visitedActivityIds`、SPECは`completed` | `completedActivityIds`に統一 |
| K08の例にTripがない | 応答`TripWriteResult`にTripを含める |
| dataStatusが`unknown`と`unavailable`で揺れている | 1つのenumに統一：`verified / fixture / unknown / unavailable / unsupported_region` |
| K23に500がない | `INTERNAL`（500）を追加。秘密やスタックは返さない |
| K16のtitleが例にない | `CopyRequest.title`は任意項目にする |
