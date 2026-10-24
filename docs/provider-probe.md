# 旅行情報Providerの実接続記録（D01）

状態：**未実施（blocked）**。課金開始の承認と上限設定について、M1 に確認中です（Issue #11）。承認されるまで `--live` は実行しません。

この文書は、実際の API が何を返し、何を返さないかと、保存・AI入力・出力の条件を記録します。D02〜D04・D07・D08 の adapter とポリシーは、ここに書かれた事実だけを前提にします。推測で埋めません。

## 実行方法

```bash
node packages/travel-data/probes/maps-probe.mjs          # 計画の表示だけ（通信なし・キー不要）
node packages/travel-data/probes/maps-probe.mjs --live   # 承認後に1回だけ実行
```

- キーは環境変数か repo 直下の `.env`（Git 管理外）の `GOOGLE_MAPS_SERVER_KEY` から読みます。出力にキーは出しません。
- 1回の実行で呼ぶのは最大 `MAX_CALLS = 20` 回です（現在の計画は7回）。再試行はせず、タイムアウトは15秒です。
- 応答の本文は保存しません。記録するのはメタデータだけです（HTTPステータス、件数、要求した項目のうち返ってきたもの・返ってこなかったもの）。

## 呼出し計画

field mask は最小限にしています。料金ランク（SKU）は field mask で決まるので、営業時間だけは別の1回（Enterprise）に分けています。料金は実行する日の料金表とプロジェクト設定で確認します（docs/08）。

| label | API | 想定SKU | 主な取得項目 |
|---|---|---|---|
| kanazawa-place | Places API (New) Text Search | Text Search Pro | id, displayName, formattedAddress, location, attributions |
| kanazawa-hours | 同上 | Text Search Enterprise | 上記＋regularOpeningHours |
| paris-place | 同上 | Text Search Pro | 上記（Pro） |
| kanazawa-drive | Routes API computeRoutes | Compute Routes Essentials | duration, distanceMeters |
| kanazawa-transit | 同上（TRANSIT、翌日10:00 JST） | 料金表で確認 | duration, distanceMeters, steps.travelMode, steps.transitDetails, travelAdvisory.transitFare |
| paris-drive | 同上 | Compute Routes Essentials | duration, distanceMeters |
| paris-transit | 同上（TRANSIT、翌日10:00 CET） | 料金表で確認 | 金沢の TRANSIT と同じ |

公式資料で確認済みの事実（2026-10-24 時点）：

- **Places API (New) Text Search**：`POST https://places.googleapis.com/v1/places:searchText`。`X-Goog-FieldMask` は必須です。
  - Essentials IDs Only：`places.id`、`places.attributions` など。
  - Pro：`places.displayName`、`places.formattedAddress`、`places.location`、`places.photos` など。
  - Enterprise：`places.regularOpeningHours`、`places.rating` など。
- **Routes API**：`POST https://routes.googleapis.com/directions/v2:computeRoutes`。
  - TRANSIT は経由地（intermediates）を指定できません。
  - 出発時刻は RFC3339 UTC で、7日前から100日後までです。
  - `transitFare` は、全区間の運賃がわかる場合にだけ返ります。
  - 公共交通の対応状況は地域によって異なります。

## 結果

未実施。実行後に、label ごとに次を記録します。

| label | 取得時刻 (UTC) | 地域 | 日付 | SKU | HTTP | 件数 | 返った項目 | 返らなかった項目 |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — |

## 保存・AI入力・出力の条件（未確定。M1 が判断）

次の点は、規約の該当箇所と一緒に記録し、M1 が最終判断します。決まるまでは、`Provenance` の `mayStore` / `maySendToModel` / `mayExport` を **false 扱い（使わない）** にします（docs/08）。

| 項目 | 確認する資料 | 状態 |
|---|---|---|
| place ID 以外の項目を何日まで保存してよいか | Google Maps Platform Terms of Service／Places API Policies | 未確認 |
| 取得値（名前・座標・営業時間・経路）を LLM の入力にしてよいか | 同上（Service Specific Terms を含む） | 未確認 |
| PDF・ICS・SNS 投稿に転載してよいか、帰属表示の要件 | Places API Policies（attributions）／Routes API Policies | 未確認 |
| 公共交通の運賃・乗り場が日本とフランスで返るか | 上の probe の結果 | 未実施 |

## 次の担当への引継ぎ

- D02（呼出し上限と保存可否の分類）：この文書の「結果」と「条件」の表が埋まってから着手します。
- 運賃・乗り場・営業時間が返らない地域では、その値を `null` と `dataStatus: 'unknown'` のままにします。AI で補完しません（docs/01_SPEC.md）。
