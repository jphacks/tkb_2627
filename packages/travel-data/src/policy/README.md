# travel-data policy（D02）

provider（Google Places / Routes）を呼ぶ前に必ず通す制限と、取得したデータの扱いです。D03・D04・D07・D08 の adapter は、ここを通して呼び出します。

## 呼出しの制限

- `CallBudget`：入力1件（検索1回、旅程生成1回）ごとに作ります。
  - 呼出し回数の上限があります（再試行も数える）。
  - 同じリクエストを連打しても、実行中の1件にまとめます。
  - 再試行は最大3回です。429 と 4xx は再試行しません。
  - 1回ごとにタイムアウトがあり、キャンセルできます。
- `DailyQuota`：SKU ごとの1日の上限です。サーバー全体で共有します。
- `Gate`：同時に走らせる呼出しの数を制限します。
- `checkArea`：検索する矩形の大きさと件数を、呼ぶ前に確かめます。

### 上限の設定（M1 の決定、Issue #12）

安全な既定値をコードに置いています（`SAFE_DEFAULT_LIMITS`）。

- 各 SKU 1日20件
- 入力1件あたり8回まで
- 同時に2件まで

共有サーバーの env では、**小さくする方向にだけ**変えられます。既定値より大きい値や不正な値を指定すると、`usageLimitsFromEnv` が例外を投げます（apps/server は、これで起動を止める想定です）。

| env | 意味 | 範囲 |
|---|---|---|
| `TRAVEL_DAILY_LIMIT_PER_SKU` | 全 SKU に共通の1日の上限 | 0〜20 |
| `TRAVEL_MAX_CALLS_PER_INPUT` | 入力1件あたりの呼出し回数 | 0〜8 |
| `TRAVEL_MAX_CONCURRENT` | 同時に走らせる呼出しの数 | 1〜2 |

**未接続です。** `apps/server` が起動時に `usageLimitsFromEnv(process.env)` と `createUsageControls(limits)` を1回だけ作り、adapter に渡す予定です。D03/D04 を接続するときに、apps/server 側で行います（`.env.example` への `TRAVEL_*` の追記も、そのときに行います）。契約（contracts）には入れません。

### 再起動で1日の回数が0に戻る

`DailyQuota` はメモリ上で数えています。共有サーバーを再起動すると（`tsx watch` による再読込を含む）、その日の回数は0から数え直します。

- 最終的な歯止めは、GCP の quota（各 API 1日100件）です。429 が返っても再試行しません。
- 共有サーバーは1台・1プロセスの構成なので、今は永続化しません（M1 の判断）。
- 複数のプロセスで動かすことになったら、回数を DB に移します。

## データの扱い

`DEFAULT_SOURCE_POLICIES` は、M1 の暫定の判断（Issue #11、docs/provider-probe.md）に沿った設定です。

- Google のデータは、`place_id`（`PlaceInfo.placeId`）だけ保存してよいです。
- それ以外は表示専用です。AI への入力と、PDF・SNS への転載はできません。

規約を確認できたら、M1 がこの表を更新します。期限が切れたデータは `purgeExpired` で除きます。AI に渡す事実は `factsForModel` を通します。
