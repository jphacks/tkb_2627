# 旅行情報Providerの実接続記録（D01）

状態：**実施済み（2026-10-24、計12回：probe の7回＋追加の1回＋adapter での確認4回（D03 2回・D04 2回））**。M1 が課金と上限（全体20回まで）を承認したうえで実行しました（Issue #11）。プロジェクトは `tkb-2627` で、各 API に1日100件の quota と月100円の予算アラートがかかっています。20回を超えて呼ぶ場合は、改めて M1 の確認が必要です。

この文書は、実際の API が何を返し、何を返さないかと、保存・AI入力・出力の条件を記録します。D02〜D04・D07・D08 の adapter とポリシーは、ここに書かれた事実だけを前提にします。推測で埋めません。

## 実行方法

```bash
node packages/travel-data/probes/maps-probe.mjs          # 計画の表示だけ（通信なし・キー不要）
```

- `--live` は実際に API を呼びます。2026-10-24 に2回実施済みです（計画全体の7回と、`--only=kanazawa-tokyo-transit` の1回）。**再実行する場合は、理由を Issue #11 に書いて M1 の了承を得てから**にしてください。
- 呼出し回数は**全体で `APPROVED_TOTAL = 20` 回まで**です。回数は実行をまたいで数えます。
  - コミット済みの実行分は `ALREADY_USED`（現在12。adapter での確認の回数も含む）に記録しています。新しい実行をコミットするときは、`ALREADY_USED` を増やし、同じ回数を数えているローカルの台帳を消します。
  - `--only=label[,label]` を付けると、指定した項目だけを実行します（カンマ区切りで複数可）。上限と台帳にも、絞り込んだ件数で数えます。知らない引数、`=` のない `--only`、空の `--only=` は、1回も呼ばずに拒否します（打ち間違いで全件を実行しないため）。
  - それ以降の実行分は、Git 管理外の `.local/provider-probe/calls.json` に記録します。
  - 計画した回数が残りを超える場合、`--live` は1回も呼ばずに拒否します。
- 再試行はしません。タイムアウトは15秒です。429 や `RESOURCE_EXHAUSTED` が返ったら、それを記録してその場で止めます。
- キーは環境変数か repo 直下の `.env`（Git 管理外）の `GOOGLE_MAPS_SERVER_KEY` から読みます。出力にキーは出しません。
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
| kanazawa-tokyo-transit | 同上（TRANSIT、金沢駅→東京駅、翌日10:00 JST）。M1 が追加で承認した1回 | 料金表で確認 | 金沢の TRANSIT と同じ |

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

## 結果（2026-10-24 実施。`--live` 2回で計8回呼出し、残り12回）

応答の本文は保存していません。下の表は probe が出力したメタデータです。出力そのもの（提供元の内容は含まない）は `packages/travel-data/probes/results/` の `2026-10-24-live.json`（7回）と `2026-10-24-live-2.json`（追加の1回）にあります。「日付」は、TRANSIT ではリクエストした出発時刻です。

| label | 取得時刻 (UTC) | 地域 | 日付 | 想定SKU | HTTP | 件数 | 返った項目 | 返らなかった項目 |
|---|---|---|---|---|---|---|---|---|
| kanazawa-place | 2026-10-24T07:56:34Z | 金沢（JP） | — | Text Search Pro | 200 | 1 | id, displayName, formattedAddress, location | attributions（応答に項目なし） |
| kanazawa-hours | 2026-10-24T07:56:35Z | 金沢（JP） | — | Text Search Enterprise | 200 | 1 | 上記＋regularOpeningHours | attributions（応答に項目なし） |
| paris-place | 2026-10-24T07:56:35Z | パリ（FR） | — | Text Search Pro | 200 | 1 | id, displayName, formattedAddress, location | attributions（応答に項目なし） |
| kanazawa-drive | 2026-10-24T07:56:35Z | 金沢（JP） | — | Compute Routes Essentials | 200 | 1 | duration, distanceMeters | — |
| kanazawa-transit | 2026-10-24T07:56:36Z | 金沢（JP） | 2026-10-25T01:00Z（10:00 JST） | 料金表で確認 | 200 | **0** | — | **経路なし**（duration, distanceMeters, steps.travelMode, steps.transitDetails, travelAdvisory.transitFare） |
| paris-drive | 2026-10-24T07:56:36Z | パリ（FR） | — | Compute Routes Essentials | 200 | 1 | duration, distanceMeters | — |
| paris-transit | 2026-10-24T07:56:36Z | パリ（FR） | 2026-10-25T09:00Z（10:00 CET） | 料金表で確認 | 200 | 1 | duration, distanceMeters, steps.travelMode, steps.transitDetails, travelAdvisory.transitFare | — |
| kanazawa-tokyo-transit | 2026-10-24T09:18:32Z | 金沢→東京（JP、直線で約300km） | 2026-10-25T01:00Z（10:00 JST） | 料金表で確認 | 200 | **0** | — | **経路なし**（kanazawa-transit と同じ5項目） |

わかったこと：

- **日本の公共交通（R05）：Routes API では取得できない場合がある**（M1 の判断に従った記録。R05 と T06 の制約）
  - 金沢駅→兼六園（約2km）も、**金沢駅→東京駅（直線で約300km、新幹線が通る区間）も**、エラーにならず**経路0件**でした（どちらも翌日10:00 JST）。
  - 長距離でも0件だったので、短距離だけが原因とは言えません。ただし確かめたのは2区間・1時刻だけで、国内全体で非対応だと公式資料で確認できたわけではありません（資料には「地域によって異なる」としか書かれていません）。
  - D04 は、国内の公共交通が返らないときは `unsupported_region` / `null` として返します。路線・時刻・運賃・乗り場を AI で補完しません。
  - 国内の公共交通を別の provider で取るかどうかは、M1 とチームが判断します。
- **パリの公共交通**：路線の詳細（`transitDetails`）と運賃（`transitFare`）が返りました。ただし `transitFare` は全区間の運賃がわかる場合にだけ返るので、常にあるとは限りません。
- **車（R06）**：金沢・パリとも、所要時間と距離が返りました。
- **地点（R02）**：名前・住所・座標が返りました。金沢の営業時間（`regularOpeningHours`）も、Enterprise の field mask で返りました。D03 が構造化した営業時間を契約に加えるときの材料になります（M1 の #77 の判断）。
- **`places.attributions`**：3件とも応答にこの項目がありませんでした。第三者の出典表示が必要なデータは、今回の結果には含まれていなかったと考えられます。ただし、結果によっては付くので、D03 では保持して表示します。
- **実際に課金された SKU**：Cloud Console の請求レポートで M1 が確認してください。TRANSIT のランクは、公式の料金表で確定していません。

## D03 の adapter での確認（2026-10-24、2回）

M1 が #14 で承認した「D03・D04 で4回まで」のうち2回を使いました。`GooglePlacesProvider` を実際の API で呼び、応答の**形だけ**を記録しています（項目名・件数・営業時間の各部分があるかどうか。地点の名前などの内容は記録していません）。出力は `packages/travel-data/probes/results/2026-10-24-d03-live.json` です。**累計10回、残り10回**（D04 の確認に、承認済みの残り2回を使います）。

| 呼出し | 取得時刻 (UTC) | 結果 |
|---|---|---|
| Text Search Enterprise（金沢、営業時間あり、1件） | 2026-10-24T10:18:13Z | 1件。`regularOpeningHours.periods` は7件で、7件すべてに `open.day`（日曜の 0 を含む）、`close`、`close.day` があった。`weekdayDescriptions` は7件。adapter はこれを毎日共通の `H:MM-H:MM` に変換した（D06 が読める形） |
| Nearby Search Pro（金沢、半径800m、`restaurant`、5件） | 2026-10-24T10:18:14Z | 5件。返った項目は id、displayName、formattedAddress、location、types、primaryType。`attributions` は返らなかった |

わかったこと：

- 営業時間の `periods` は、リファレンスどおりの形で返った（曜日が省略されることはなかった。確かめたのは1地点）。
- `restaurant` を指定した Nearby Search で、一部の結果が adapter の判定で `spot` になった。`japanese_restaurant` のような細かい種類が対応表になく、後ろの汎用の種類が先に一致したためと考えられる。`_restaurant` で終わる種類は飲食店として扱うよう修正した（D03 の PR）。

## D04 の adapter での確認（2026-10-24、2回）

M1 が #14 で承認した4回の残り2回です。`GoogleRoutesProvider` を実際の API で呼び、応答の**形だけ**を記録しました。出力は `packages/travel-data/probes/results/2026-10-24-d04-live.json` です。**累計12回、残り8回**。承認された「D03・D04 の確認4回」は、これで使い切りました。

| 呼出し | 取得時刻 (UTC) | 結果 |
|---|---|---|
| TRANSIT（Louvre→Orsay、翌日09:00Z） | 2026-10-24T10:25:09Z | 経路あり。step 12件のうち TRANSIT は1件で、12件すべてに `staticDuration` があった。adapter は地点から地点の出発・到着時刻を計算でき、全体の所要時間と**差0秒で一致**した。路線名・運賃・乗車駅名・降車駅名あり、乗換0回 |
| DRIVE（金沢駅→兼六園） | 2026-10-24T10:25:10Z | 所要時間あり。出発・到着時刻と `transit` は null（作らない） |

## 保存・AI入力・出力の条件（M1 が最終判断）

**M1 の判断（2026-10-24、Issue #11）**：Service Specific Terms を確認できるまでは、保守的な既定にします。D02（#88）の `DEFAULT_SOURCE_POLICIES` は、この判断に沿った設定です。

- **保存**：`place_id` だけを保存してよい。それ以外の地点データ・経路データは、その場で取得して表示するだけにし、DB にも snapshot にも保存しない。
- **AIへの入力**：不可。A04 で Claude に渡すのは、利用者の入力、`place_id`、プログラムが計算した事実だけ。
  - D02 での扱い：`place_id` は `GenerationInput.allowedPlaceIds` で渡ります。`factsForModel` は、`maySendToModel=false` の地点（名前・座標・営業時間など）を、`facts` から丸ごと除きます。
- **PDF・SNSへの転載**：不可。provider の名前・住所・写真を載せない。
- **表示**：Google の地図の上に表示するか、地図なしで表示する場合は Google のロゴと帰属表示を付ける（M2 の U04・U07 で対応）。
- **実際に課金された SKU**：M1 が Cloud Console で確認して、Issue #11 に追記する。

規約を確認できたら、M1 が設定表を更新します。それまでの既定値は次のとおりです。

- `maySendToModel=false`
- `mayStore=false`（ただし `place_id` だけは保存してよい）
- `mayExport=false`

取得した生データはコミットしません。

### 規約で確認できた箇所（S13：Places API Policies、2026-10-21 更新版を 2026-10-24 に確認）

- **place ID**："the place ID, used to uniquely identify a place, is exempt from the caching restrictions" ／ "You can therefore store place ID values indefinitely."
- **その他の内容**："You must not pre-fetch, cache, or store Places API content beyond the allowed exceptions"。例外の中身（座標を何日まで保存してよいかなど）は Service Specific Terms にあり、このページには書かれていません。
- **地図に表示する場合**："Places API results displayed on a map must be shown on a Google Map"
  - **M2 への影響**：Places の結果を、Google 以外の地図（OSM・Leaflet など）に表示できません。
- **地図なしで表示する場合**："When displaying Places API data without a Google Map, you must include the Google logo"
- **帰属**：
  - 第三者の出典がある場合、"only including "Google Maps" or the Google logo is not proper attribution."
  - 写真・レビューを表示する場合、"You must always credit the author"
- **AI**：このページには、Places の内容を LLM の入力にしてよいかの記述はありません。AI に関する記述は、**Places API が提供する AI 要約**を表示する場合に開示文が必要、というものだけです。自分たちの LLM が作った要約については何も書かれていません。

### 未確認（M1 が確認・判断）

| 項目 | 資料 | 状態 |
|---|---|---|
| 座標・名前・営業時間・経路を保存してよい期間 | Service Specific Terms（Places API / Routes API の caching） | **未確認**：このページは JavaScript で描画されるため、本文を取得できませんでした。記憶から推測した値は書きません |
| 取得値を LLM（本人の Claude）の入力にしてよいか | Terms of Service／Service Specific Terms | **未確認**。既定は `maySendToModel=false` |
| PDF・ICS・SNS に転載してよいか | 同上＋Places API Policies | **未確認**。既定は `mayExport=false`。E03（ICS・Maps URL）は `mayExport=false` を除外済み。PDF と SNS は別のタスク |
| Routes の結果を Google 以外の地図に描いてよいか | Routes API Policies | 未確認 |

## A04 での適用（#28 の D-1・D-2、2026-10-24、M1）

- **D-1（Routes の結果）**：live Routes の所要時間から計算した予定の開始・終了時刻は、利用者の旅程として batch に保存してよい。Routes から取得した区間の詳細（`durationSeconds`・`fare`・`lineName`・`platform`・`transit`）は保存せず `null` にし、その区間に「移動情報は表示時に再取得」の警告を付ける。K07 は、Google 由来の区間に `durationSeconds`・`fare`・`lineName`・`platform`・`transfers` のどれか、または Google 由来の地点に `location`・`openingHours`・`description`・`photo` のどれかが入っていれば、422 RESTRICTED_ASSET で拒否する（`apps/server/src/trips/generation/verify-batch.ts`）。規約（Service Specific Terms）を確認できたら見直す。
- **D-2（Google の地点内容）**：名前・座標・営業時間は、保存もモデル入力もしない（上の既定のまま）。保存してよいのは `place_id` だけ。モデルには利用者の入力、`place_id`、プログラムが計算した事実だけを渡す。純粋な live モードで地点の情報が足りない場合は、成功を装わず警告付きの `needs_review` にする。
- **デモ**：`PROVIDER_MODE=mixed`（地点は fixture、経路は live Routes）。1ジョブの live Routes 呼出しは `AI_MAX_LIVE_LEGS`（最大6）まで。実機確認（2026-10-24、M4）では Routes 6回・Places 0回だった（docs/claude-connection-check.md）。

## GCP の設定状況と呼出し上限（2026-10-25、利用者の確認、M1）

- GCP プロジェクト `tkb-2627` は無料トライアル中で、10月の料金は0円です。Routes は Essentials で4回使用しており、無料枠は月10,000回です。
- **Routes API の GCP 側の1日 quota は無制限でした**（100件/日で止まる設定にはなっていません）。Places API の1日 quota は未確認です。予算アラート（月100円）は通知だけで、呼出しを止めません。GCP 側の設定は変更しない方針です。
- そのため、**呼出しを確実に止めるのは、アプリのコード側の上限だけです。** 上限は外さず、env で上げられるようにもしません。
  - サーバー全体（D02）：Places は SKU ごとに1日20回（4 SKU で80回、想定100回以内）、Routes は SKU ごとに1日60回（2 SKU で120回、想定200回以内）
  - 1人1日の live 経路（K05・A05・A06 で共有）：既定20回（最大20回）
  - 1回の生成・プレビュー：live 経路は最大6回
- 少し超える程度なら問題ない、というのが利用者の判断です。大きく引き上げる場合は、利用者の了承を取ります。

## 次の担当への引継ぎ

- D02（呼出し上限と保存可否の分類）：上の既定値（`place_id` だけ保存してよい、それ以外は false）で着手できます。M1 の判断で変わる部分は、設定で切り替えられるようにします。
- D04：国内の公共交通は「取得不可」として返します（上記のとおり、短距離・長距離の2区間とも0件）。パリの公共交通は、運賃が返らないこともあり得ます。
- 運賃・乗り場・営業時間が返らない地域では、その値を `null` と `dataStatus: 'unknown'` のままにします。AI で補完しません（docs/01_SPEC.md）。
