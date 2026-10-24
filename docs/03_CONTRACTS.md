# 入出力契約 v4

自作アプリの実装先契約。一部のルートは稼働している（下記）。数値とIDは説明用。正本はmodel/contracts.json。

**実装（B02）**：Zod v4のschema v1を`packages/contracts`に置いた。表現の決まり、資料間の食い違いの解決、破壊的変更の手順は`packages/contracts/README.md`を参照。2026-10-24時点で稼働しているルートは次のとおり。共有サーバー（:4310）：`GET /api/v1/health`、`GET /api/v1/capabilities`、`POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`、`POST /api/v1/plan-batches`、`GET /api/v1/plan-batches`（`?generationId=`）、`GET /api/v1/plan-batches/{id}`、`POST /api/v1/trips/apply-candidate`、`GET /api/v1/trips`、`GET /api/v1/trips/{id}`、`PATCH /api/v1/trips/{id}`、`POST /api/v1/posts/preview`、`POST /api/v1/posts`、`GET /api/v1/posts`、`GET /api/v1/posts/{id}`、`PATCH /api/v1/posts/{id}`、`DELETE /api/v1/posts/{id}`、`POST /api/v1/posts/{id}/copy`、`POST /api/v1/groups`、`GET /api/v1/groups`、`POST /api/v1/groups/{id}/invites`、`POST /api/v1/group-invites/accept`、`DELETE /api/v1/groups/{id}/members/{userId}`。本人用App Server（:4311）：`GET /local/v1/health`、`GET /local/v1/capabilities`、`POST /local/v1/pair`、`POST /local/v1/auth/login`、`GET /local/v1/session`、`POST /local/v1/generations`、`GET /local/v1/jobs/{jobId}`、`POST /local/v1/jobs/{jobId}/cancel`。

## K01 本人の旅程生成受付

通信：POST /local/v1/generations

権限：ローカルセッション＋Host/Origin/CSRF＋本人所有権

入力：GenerateRequest：constraints、mode?（generate／replan）、baseTripId?、expectedRevision?。Idempotency-Keyヘッダー（必須）。ownerIdと未知のキーは受け付けない。

戻り値：202 JobAccepted：jobId、state=queued、pollAfterMs。完成した旅程はこの応答に含めない。

失敗：401本人未認証／403利用不可／409 IDEMPOTENCY_CONFLICT（同じキーで入力違い）／422入力不正（Idempotency-Key不正を含む）／429 QUEUE_FULL（待機上限）

数値とIDは説明用。本人の操作だけを受付。共有サーバーや公開ユーザーの生成依頼は転送しない。mode=replan、baseTripId、expectedRevisionは、共有サーバーでの所有確認ができるまで422（VALIDATION_FAILED）で拒否する。同じキー・同じ入力の再送は同じjobIdを返す。

入力例：
```json
{
  "constraints": {
    "area": "金沢",
    "startDate": "2026-11-01",
    "endDate": "2026-11-02",
    "timeZone": "Asia/Tokyo",
    "transportMode": "transit",
    "budget": {
      "amountMinor": 30000,
      "currency": "JPY"
    },
    "mustVisit": [
      "user-place-a"
    ]
  }
}
```
戻り例：
```json
{
  "jobId": "job_example",
  "state": "queued",
  "pollAfterMs": 2000
}
```

## K02 生成状況・結果参照

通信：GET /local/v1/jobs/{jobId}

権限：ローカル本人セッション

入力：jobId。セッションの利用者とジョブ所有者を照合。

戻り値：200 JobStatus：jobId、state（queued／running／succeeded／failed／cancelled）、stage、batchId（null可）、error（null可）、updatedAt。stageはqueued、collecting_context、generating、validating、saving、saved、doneのいずれか。成功時（succeeded）のstageはdoneで、batchIdが入る。成功時の候補本体は共通DBのbatchIdから取得。

失敗：401本人未ログイン／404他人または不存在／503本人App Server停止

2秒から始め最大10秒へ間隔を伸ばす。切断後もjobIdで再確認。終了状態では停止。

入力例：
```json
{
  "jobId": "job_example"
}
```
戻り例：
```json
{
  "jobId": "job_example",
  "state": "succeeded",
  "stage": "done",
  "batchId": "batch_example",
  "error": null,
  "updatedAt": "2026-10-24T00:00:00Z"
}
```

## K03 Claude Codeへの生成依頼と戻り値

通信：子プロセス：stdin / stdout(JSON) / stderr / exit code

権限：PC所有者の未改変公式Claude Code認証

入力：GenerationInput：旅行条件、利用許諾済みの事実、候補ID、固定予定、出力Schema。任意shellコマンドは含めない。CLI引数は固定配列：-p、--output-format json、--json-schema <PlanBlueprint>、--tools ""、--strict-mcp-config、--no-session-persistence、--model <CLAUDE_MODEL>。promptはstdin。

戻り値：CLI envelope内のstructured_outputをSchema検証したPlanBlueprint。自然文をそのままTripとして保存しない。

失敗：CLI_NOT_AUTHENTICATED（未ログイン）／CLI_LIMIT（CLIのresultがis_errorで、api_error_statusが429または529）／CLI_TIMEOUT（自前タイマーの時間切れ）／CLI_EXIT（終了コードが0以外、起動不能、または上記以外のCLIエラー）／INVALID_OUTPUT（structured_outputがSchemaに合わない）

構造化出力でも真実性は保証されない。stdoutの成功フラグ、終了コード、Schemaを別々に確認。これらのコードは通常HTTP応答ではなくK02のJobStatus.errorに入る。

入力例：
```json
{
  "schemaVersion": 1,
  "constraints": {
    "area": "金沢",
    "startDate": "2026-11-01",
    "endDate": "2026-11-02",
    "timeZone": "Asia/Tokyo",
    "transportMode": "transit"
  },
  "allowedPlaceIds": [
    "user-place-a",
    "user-place-b"
  ],
  "facts": [],
  "fixedActivities": [],
  "instructions": "候補IDだけを使用し、不明時刻・運賃を捏造しない"
}
```
戻り例：
```json
{
  "schemaVersion": 1,
  "candidates": [
    {
      "candidateId": "candidate_1",
      "activityOrder": [
        "user-place-a",
        "user-place-b"
      ],
      "reasons": [
        "希望地点を優先"
      ],
      "warnings": []
    }
  ]
}
```

## K04 Claude CodeとClaudeサービスの通信

通信：Anthropic公式CLIが管理するHTTPS

権限：公式CLI自身のサブスク認証

入力：公式CLIが旅行指示・文脈を送信。アプリがOAuth tokenを読み出して自作リクエストを作らない。

戻り値：Claudeの出力を公式CLIが受信し、K03の出力へ変換する。

失敗：サービス側の利用上限／通信失敗／認証失敗

この内部HTTPSのpayloadを本キットは実装・定義しない。CLIの公式仕様に委ねる。

入力例：
```json
{
  "managedBy": "official-claude-code",
  "content": "旅行指示と許諾済みデータ"
}
```
戻り例：
```json
{
  "managedBy": "official-claude-code",
  "content": "旅程候補"
}
```

## K05 生成用の旅行情報取得

通信：POST /api/v1/planning-context

権限：本人のアプリ利用者セッション

入力：PlanningContextRequest：area、transportMode、maxPlaces（1〜30、既定8）、placeIds?（30件まで）、timeZone?（IANA。地点検索に必要）、legs?（RouteQuery：fromPlaceId・toPlaceId・departureUtc・mode=transit|car|walk、8件まで）。timeZoneとlegsはschemaVersion 1のままの互換追加。

戻り値：200 PlanningContext：places（PlaceInfo）、legs（TravelLeg）、unknown（取得できなかった項目名）、dataMode。DBへ保存せず、cache-control: no-store。

失敗：401／422 VALIDATION_FAILED（不正な要求）／422 PROVIDER_UNSUPPORTED_REGION／429 RATE_LIMITED（利用者ごとの上限：同時1件、1日PLANNING_CONTEXT_DAILY_PER_USER件。同時実行中だけretryable）／429 PROVIDER_RATE_LIMIT（外部APIのTRAVEL_*上限）／503 PROVIDER_UNAVAILABLE／接続切断時は処理を中止して応答しない

実際の外部データをAIへ渡せるかは情報源別に判定。禁止・不明ならその値を除外し、生成後のプログラム照合だけに使う。要求内容はログに残さない。Googleの地点内容は保存もモデル入力もしない（place_idだけ。#11/#28 D-2）。

入力例：
```json
{
  "area": "金沢",
  "transportMode": "car",
  "maxPlaces": 8,
  "timeZone": "Asia/Tokyo",
  "legs": [
    {
      "fromPlaceId": "fx_kanazawa_station",
      "toPlaceId": "fx_kenrokuen",
      "departureUtc": "2026-11-01T00:00:00Z",
      "mode": "car"
    }
  ]
}
```
戻り例：
```json
{
  "places": [
    {
      "placeId": "fx_kanazawa_station",
      "name": "金沢駅",
      "kind": "station",
      "location": {
        "lat": 36.578,
        "lng": 136.648
      },
      "timeZone": "Asia/Tokyo",
      "openingHours": null,
      "description": null,
      "photo": null,
      "dataStatus": "fixture",
      "provenance": {
        "source": "fixture",
        "fetchedAt": null,
        "attribution": "tkb_2627 fixture",
        "maySendToModel": true,
        "mayStore": true,
        "mayExport": true,
        "retainUntil": null
      }
    }
  ],
  "legs": [],
  "unknown": [
    "fare"
  ],
  "dataMode": "fixture"
}
```

## K06 外部の地点・経路データ照会

通信：HTTPS：旅行情報ProviderAdapter

権限：サービスごとのキー。秘密キーはサーバーのみ

入力：検索語・領域、または出発地・到着地・出発時刻・交通手段。

戻り値：正規化PlaceInfo／TravelLeg、取得時刻、出典、attribution、retentionPolicy、null。

失敗：UNAVAILABLE／RATE_LIMIT／UNSUPPORTED_REGION

これは自作adapterの共通型。Google側のHTTPフィールド名は公式API仕様に従う。運賃、ホーム、時刻をAIで補完しない。

入力例：
```json
{
  "originRef": "place_a",
  "destinationRef": "place_b",
  "departureUtc": "2026-11-01T01:00:00Z",
  "mode": "transit"
}
```
戻り例：
```json
{
  "durationSeconds": null,
  "fare": null,
  "platform": null,
  "dataStatus": "unknown"
}
```

## K07 生成候補を共通サーバーへ保存

通信：POST /api/v1/plan-batches / GET /api/v1/plan-batches/{id} / GET /api/v1/plan-batches?generationId={id}

権限：アプリ本人セッション。AI認証とは無関係

入力：PlanBatchCreate：schemaVersion、baseTripId（null可）、baseRevision（null可）、generationId（本人用App Serverのoperation key）、candidates（1〜3件）、places、constraints?。未知のキーは受け付けない。baseTripId=nullの新規旅程へ採用するには constraints が必要。GET ?generationId=は本人のbatchだけを照会し、200 {batchId}だけを返す（queryはgenerationIdの1キーのみ）。

戻り値：201 PlanBatchCreated（batchId、candidateIds、validationState）。同じgenerationIdで同じ内容の再送は200で同じ応答。GET /{id}は200 PlanBatch。保持期限切れのbatchは410。全候補の保存先は共通DB。

失敗：401／404 NOT_FOUND（他人・不存在は同じ。GET ?generationId=も同様）／409 IDEMPOTENCY_CONFLICT（同じgenerationIdで内容違い）または409 REVISION_CONFLICT（元旅程の版が違う）／410 EXPIRED（期限切れbatchのGET）／422 VALIDATION_FAILED（不正候補、またはcandidatesが参照する地点IDがplacesにない）・422 RESTRICTED_ASSET（保存してはならないデータ）

サーバーでも型・所有権・データ保持条件を検証。クライアントが付けた「Claude生成」等のラベルを権限の証拠にしない。保存時の候補のvalidationStateはneeds_review以上に補正する（クライアントのvalidは信用しない）。再送の判定は、期限・元旅程の検査より先に行う。GET ?generationId=は再起動後の二重保存防止に使い、cache-control: no-storeで返す。Routes由来の区間はdurationSeconds・fare・lineName・platform・transfersをnullで保存し（K07はGoogle由来の区間・地点にこれらの値があれば422 RESTRICTED_ASSET）、「表示時に再取得」の警告を付ける（#28 D-1）。予定の開始・終了時刻は保存してよい。

入力例：
```json
{
  "schemaVersion": 1,
  "baseTripId": null,
  "baseRevision": null,
  "generationId": "gen_example",
  "candidates": [
    {
      "candidateId": "candidate_1",
      "title": "金沢1日コース",
      "days": [
        {
          "date": "2026-11-01",
          "timeZone": "Asia/Tokyo",
          "items": [
            {
              "type": "activity",
              "activityId": "activity_a",
              "kind": "visit",
              "title": "地点A",
              "placeId": "user-place-a",
              "areaName": null,
              "start": {
                "utc": "2026-11-01T00:00:00Z",
                "timeZone": "Asia/Tokyo"
              },
              "end": {
                "utc": "2026-11-01T01:30:00Z",
                "timeZone": "Asia/Tokyo"
              },
              "fixed": false,
              "status": "planned",
              "cost": null,
              "costStatus": "unknown",
              "privateNotes": null
            },
            {
              "type": "activity",
              "activityId": "activity_b",
              "kind": "visit",
              "title": "地点B",
              "placeId": "user-place-b",
              "areaName": null,
              "start": {
                "utc": "2026-11-01T00:00:00Z",
                "timeZone": "Asia/Tokyo"
              },
              "end": {
                "utc": "2026-11-01T01:30:00Z",
                "timeZone": "Asia/Tokyo"
              },
              "fixed": false,
              "status": "planned",
              "cost": null,
              "costStatus": "unknown",
              "privateNotes": null
            }
          ]
        }
      ],
      "reasons": [
        "希望地点を優先"
      ],
      "warnings": [
        "説明用データ"
      ],
      "excludedPlaceIds": [],
      "totalKnownCost": [],
      "hasUnknownCost": true,
      "validationState": "needs_review"
    }
  ],
  "places": [
    {
      "placeId": "user-place-a",
      "name": "説明用の地点A",
      "kind": "spot",
      "location": {
        "lat": 36.56,
        "lng": 136.66
      },
      "timeZone": "Asia/Tokyo",
      "openingHours": null,
      "description": null,
      "photo": null,
      "dataStatus": "fixture",
      "provenance": {
        "source": "fixture",
        "fetchedAt": null,
        "attribution": null,
        "maySendToModel": true,
        "mayStore": true,
        "mayExport": true,
        "retainUntil": null
      }
    },
    {
      "placeId": "user-place-b",
      "name": "説明用の地点B",
      "kind": "spot",
      "location": {
        "lat": 36.56,
        "lng": 136.66
      },
      "timeZone": "Asia/Tokyo",
      "openingHours": null,
      "description": null,
      "photo": null,
      "dataStatus": "fixture",
      "provenance": {
        "source": "fixture",
        "fetchedAt": null,
        "attribution": null,
        "maySendToModel": true,
        "mayStore": true,
        "mayExport": true,
        "retainUntil": null
      }
    }
  ],
  "constraints": {
    "area": "金沢",
    "startDate": "2026-11-01",
    "endDate": "2026-11-02",
    "timeZone": "Asia/Tokyo",
    "transportMode": "transit"
  }
}
```
戻り例：
```json
{
  "batchId": "batch_example",
  "candidateIds": [
    "candidate_1"
  ],
  "validationState": "needs_review"
}
```

## K08 候補の採用と旅程保存

通信：POST /api/v1/trips/apply-candidate

権限：ログイン利用者がbatchとtripの両方を所有

入力：ApplyCandidateRequest：batchId、candidateId、tripId（新規はnull）、expectedRevision（新規はnull、既存旅程へ適用するときは必須）。未知のキーは受け付けない。

戻り値：201新規／200再送または更新：TripWriteResult（tripId、revision、trip、warnings）。新規のtripIdは(利用者, batchId, candidateId)から決まるため、同じ候補の再送は200で同じ旅程を返す。

失敗：404 NOT_FOUND（batch・候補・旅程の所有権）／409 REVISION_CONFLICT（古い版。details: expectedRevision、currentRevision）／409 ALREADY_COMMITTED（適用済みで旅程は削除済み）／422 VALIDATION_FAILED（expectedRevisionの要否違反、別の旅程向けの候補、baseTripId=nullのbatchを既存旅程へ適用）／422 CONSTRAINT_UNSATISFIED（未検証）／422 RESTRICTED_ASSET（保存不可）

候補取得→所有権→版確認→trip_versions挿入→trips更新を短いDB transactionで行う。自動的にSNSへ公開しない。

入力例：
```json
{
  "batchId": "batch_example",
  "candidateId": "candidate_1",
  "tripId": null,
  "expectedRevision": null
}
```
戻り例：
```json
{
  "tripId": "trip_example",
  "revision": 1,
  "trip": {
    "schemaVersion": 1,
    "tripId": "trip_example",
    "ownerId": "user_a",
    "title": "金沢1泊2日",
    "revision": 1,
    "constraints": {
      "area": "金沢",
      "startDate": "2026-11-01",
      "endDate": "2026-11-02",
      "timeZone": "Asia/Tokyo",
      "transportMode": "transit"
    },
    "days": [
      {
        "date": "2026-11-01",
        "timeZone": "Asia/Tokyo",
        "items": [
          {
            "type": "activity",
            "activityId": "activity_a",
            "kind": "visit",
            "title": "地点A",
            "placeId": "user-place-a",
            "areaName": null,
            "start": {
              "utc": "2026-11-01T00:00:00Z",
              "timeZone": "Asia/Tokyo"
            },
            "end": {
              "utc": "2026-11-01T01:30:00Z",
              "timeZone": "Asia/Tokyo"
            },
            "fixed": false,
            "status": "planned",
            "cost": null,
            "costStatus": "unknown",
            "privateNotes": null
          },
          {
            "type": "activity",
            "activityId": "activity_b",
            "kind": "visit",
            "title": "地点B",
            "placeId": "user-place-b",
            "areaName": null,
            "start": {
              "utc": "2026-11-01T00:00:00Z",
              "timeZone": "Asia/Tokyo"
            },
            "end": {
              "utc": "2026-11-01T01:30:00Z",
              "timeZone": "Asia/Tokyo"
            },
            "fixed": false,
            "status": "planned",
            "cost": null,
            "costStatus": "unknown",
            "privateNotes": null
          }
        ]
      }
    ],
    "places": [
      {
        "placeId": "user-place-a",
        "name": "説明用の地点A",
        "kind": "spot",
        "location": {
          "lat": 36.56,
          "lng": 136.66
        },
        "timeZone": "Asia/Tokyo",
        "openingHours": null,
        "description": null,
        "photo": null,
        "dataStatus": "fixture",
        "provenance": {
          "source": "fixture",
          "fetchedAt": null,
          "attribution": null,
          "maySendToModel": true,
          "mayStore": true,
          "mayExport": true,
          "retainUntil": null
        }
      },
      {
        "placeId": "user-place-b",
        "name": "説明用の地点B",
        "kind": "spot",
        "location": {
          "lat": 36.56,
          "lng": 136.66
        },
        "timeZone": "Asia/Tokyo",
        "openingHours": null,
        "description": null,
        "photo": null,
        "dataStatus": "fixture",
        "provenance": {
          "source": "fixture",
          "fetchedAt": null,
          "attribution": null,
          "maySendToModel": true,
          "mayStore": true,
          "mayExport": true,
          "retainUntil": null
        }
      }
    ],
    "validationState": "needs_review",
    "warnings": [],
    "createdAt": "2026-10-24T00:00:00Z",
    "updatedAt": "2026-10-24T00:00:00Z"
  },
  "warnings": []
}
```

## K09 保存済み旅程の読出し

通信：GET /api/v1/trips または /api/v1/trips/{id}

権限：セッションownerId

入力：一覧：query limit（1〜100、既定50）、cursor（前回のnextCursor）。詳細：tripId。

戻り値：一覧は200 TripList：items（TripSummary：tripId、title、revision、validationState、updatedAt、area、startDate、endDate）とnextCursor（次が無ければnull。更新が新しい順）。詳細は200 Trip。公開他人旅程はPost経由で読む。

失敗：401／404他人または不存在／422 VALIDATION_FAILED（limit範囲外、不正なcursor、未知のquery）

別端末でも同じアプリ利用者なら同じサーバーデータを参照。DBファイルは端末間でコピーしない。

入力例：
```json
{
  "limit": 50,
  "cursor": null
}
```
戻り例：
```json
{
  "items": [
    {
      "tripId": "trip_example",
      "title": "金沢1泊2日",
      "revision": 1,
      "validationState": "needs_review",
      "updatedAt": "2026-10-24T00:00:00Z",
      "area": "金沢",
      "startDate": "2026-11-01",
      "endDate": "2026-11-02"
    }
  ],
  "nextCursor": null
}
```

## K10 編集保存と版競合

通信：PATCH /api/v1/trips/{id}

権限：旅程のowner

入力：TripPatchRequest：expectedRevision、operations（1〜50件。add／remove／move／update／set_title）。操作はitemId（activityIdまたはlegId）で対象を指す。未知のキーは受け付けない。

戻り値：200 TripPatchResult：tripId、revision（新しい版）、trip、warnings、diff（TripDiff：durationDeltaSeconds、knownCostDelta、unknownCostItems）。構造の編集後はvalidationStateがneeds_revalidationになる。set_titleだけならvalidationStateは変えない。

失敗：404所有権／409 REVISION_CONFLICT（details: expectedRevision、currentRevision）／422 CONSTRAINT_UNSATISFIED（操作を適用できない。details: operationIndex、reason）／422 VALIDATION_FAILED（形式不正、50件超）／422 RESTRICTED_ASSET

操作は先頭から順に、全部成功するか全部失敗するかで適用する。差分の定義は本書末尾のK10の差分（TripDiff）のとおり。公開の手動編集はClaude不要。AIで残りを作り直す操作はK01経由。【拡張：A05の代替案プレビュー】POST /api/v1/trips/{id}/alternatives。要求はAlternativesRequest（PATCHと同じ厳格なbody＋maxAlternatives?（1〜3））。戻り値は200 AlternativesResult（tripId、baseRevision、candidates[]：candidateId、kind=requested|reorder|swap、summary、trip（表示用）、diff（このoperationsをPATCHしたときと同じ差分）、displayOnly?、affectedSegments[]（travel=known|none|unknown）、validationState、warnings、unknown、operations（PATCHでそのまま適用できる操作。書けない場合はnull））。何も保存せず、版も上げず、cache-control: no-store。適用はoperationsをexpectedRevision=baseRevisionでPATCHする（古い版なら409）。失敗：401／403 CSRF／404（他人・不存在）／409 REVISION_CONFLICT／422 VALIDATION_FAILED・CONSTRAINT_UNSATISFIED・RESTRICTED_ASSET／429 RATE_LIMITED（1人同時1件。live・mixedではK05と同じ1日の上限と、K05と共有するlive経路の上限LIVE_ROUTE_CALLS_PER_USER_PER_DAY（既定20、最大20）。使い切ったら区間は不明のまま警告を付ける）。live経路の詳細は表示用のtripにだけ入り、operationsには入れない。【拡張：A06の旅行中の再計画プレビュー】POST /api/v1/trips/{id}/replan。要求はReplanRequest（厳格なbody：expectedRevision、location（coords｜place｜unavailable=denied|error|skipped）、completedActivityIds、missedActivityIds、fixedActivityIds（この実行のときだけ固定扱い）、operations（先に適用する行き先の変更）、maxCandidates（1〜2、既定1））。現在時刻はクライアントから受け取らず、サーバーの時計を使う。戻り値は200 ReplanResult（tripId、baseRevision、now、dayIndex、start（kind・placeId。座標は含めない）、startLeg（表示専用。tripとoperationsには入れない）、candidates[]：kind=keep_order|reorder、trip、diff、operations、kept、retimed、untimed、reservationConflicts（missed|unreachable|travel_unknown|time_unknown））。完了済みの予定と固定予約は動かさない。何も保存しない。適用はoperationsをexpectedRevision=baseRevisionでPATCHする。現在地の座標は保存せず、ログにも応答にも出さず、Claudeにも渡さない。live・mixedでは「現在地→次の予定」の経路検索にだけ使う（#118でM1が承認）。失敗：401／403 CSRF／404／409 REVISION_CONFLICT／422 VALIDATION_FAILED・CONSTRAINT_UNSATISFIED（旅行期間外など）・RESTRICTED_ASSET／429 RATE_LIMITED（live経路の上限はK05・A05と共有）。

入力例：
```json
{
  "expectedRevision": 3,
  "operations": [
    {
      "op": "remove",
      "itemId": "activity_b"
    },
    {
      "op": "set_title",
      "title": "金沢1日コース"
    }
  ]
}
```
戻り例：
```json
{
  "tripId": "trip_example",
  "revision": 4,
  "trip": {
    "schemaVersion": 1,
    "tripId": "trip_example",
    "ownerId": "user_a",
    "title": "金沢1日コース",
    "revision": 4,
    "constraints": {
      "area": "金沢",
      "startDate": "2026-11-01",
      "endDate": "2026-11-02",
      "timeZone": "Asia/Tokyo",
      "transportMode": "transit"
    },
    "days": [
      {
        "date": "2026-11-01",
        "timeZone": "Asia/Tokyo",
        "items": [
          {
            "type": "activity",
            "activityId": "activity_a",
            "kind": "visit",
            "title": "地点A",
            "placeId": "user-place-a",
            "areaName": null,
            "start": {
              "utc": "2026-11-01T00:00:00Z",
              "timeZone": "Asia/Tokyo"
            },
            "end": {
              "utc": "2026-11-01T01:30:00Z",
              "timeZone": "Asia/Tokyo"
            },
            "fixed": false,
            "status": "planned",
            "cost": null,
            "costStatus": "unknown",
            "privateNotes": null
          }
        ]
      }
    ],
    "places": [
      {
        "placeId": "user-place-a",
        "name": "説明用の地点A",
        "kind": "spot",
        "location": {
          "lat": 36.56,
          "lng": 136.66
        },
        "timeZone": "Asia/Tokyo",
        "openingHours": null,
        "description": null,
        "photo": null,
        "dataStatus": "fixture",
        "provenance": {
          "source": "fixture",
          "fetchedAt": null,
          "attribution": null,
          "maySendToModel": true,
          "mayStore": true,
          "mayExport": true,
          "retainUntil": null
        }
      },
      {
        "placeId": "user-place-b",
        "name": "説明用の地点B",
        "kind": "spot",
        "location": {
          "lat": 36.56,
          "lng": 136.66
        },
        "timeZone": "Asia/Tokyo",
        "openingHours": null,
        "description": null,
        "photo": null,
        "dataStatus": "fixture",
        "provenance": {
          "source": "fixture",
          "fetchedAt": null,
          "attribution": null,
          "maySendToModel": true,
          "mayStore": true,
          "mayExport": true,
          "retainUntil": null
        }
      }
    ],
    "validationState": "needs_revalidation",
    "warnings": [
      "移動情報を再確認してください"
    ],
    "createdAt": "2026-10-24T00:00:00Z",
    "updatedAt": "2026-10-24T00:00:00Z"
  },
  "warnings": [
    "移動情報を再確認してください"
  ],
  "diff": {
    "durationDeltaSeconds": -5400,
    "knownCostDelta": [],
    "unknownCostItems": [
      "activity_b"
    ]
  }
}
```

## K11 アプリへのログイン

通信：POST /api/v1/auth/login（本人入口は限定proxy）

権限：パスワードの検証とセッション発行

入力：アプリのloginIdとpassword。Claudeの認証情報は入力しない。

戻り値：HttpOnlyアプリセッションcookie＋userId＋csrfToken。

失敗：401／429試行制限

個人App Serverは上流セッションをサーバー内だけに保持し、ローカル用cookieへ対応付ける。本人用allowlist利用者とローカルペアリングも検証する。

入力例：
```json
{
  "loginId": "demo-a",
  "password": "<本人が入力>"
}
```
戻り例：
```json
{
  "userId": "user_a",
  "csrfToken": "<画面用>"
}
```

## K12 SNS公開前プレビュー

通信：POST /api/v1/posts/preview

権限：旅程owner。groupは所属確認

入力：tripId、sourceRevision、visibility、groupId?、story、公開したい項目。

戻り値：Preview：安全化したsnapshot、redactedFields、previewToken、expiresAt。

失敗：404／409旅程の版違い／422公開範囲不正

サーバー側で元旅程から構成。ブラウザ提出の任意スナップショットを信用しない。10分有効は初期設計値。

入力例：
```json
{
  "tripId": "trip_example",
  "sourceRevision": 4,
  "visibility": "group",
  "groupId": "group_a",
  "story": "金沢の旅行記録"
}
```
戻り例：
```json
{
  "previewToken": "preview_example",
  "redactedFields": [
    "homeAddress",
    "preciseCurrentLocation",
    "privateNotes"
  ],
  "expiresAt": "2026-11-01T12:10:00Z"
}
```

## K13 SNS投稿の確定

通信：POST /api/v1/posts

権限：投稿者本人＋CSRF

入力：previewToken、表示確認への同意。

戻り値：201 Post：postId、postRevision、visibility、公開用snapshot。

失敗：409プレビュー後の旅程更新／410期限切れ／404所有権・所属

previewの所有者、期限、元旅程版、group所属を再確認し、投稿と不変snapshotを同一transactionで保存。下書きの後日編集は投稿に自動反映しない。

入力例：
```json
{
  "previewToken": "preview_example",
  "confirmed": true
}
```
戻り例：
```json
{
  "postId": "post_example",
  "postRevision": 1,
  "visibility": "group"
}
```

## K14 SNSフィードと投稿読出し

通信：GET /api/v1/posts?scope=...&cursor=... / posts/{id}

権限：公開=匿名可、group=現時点の所属、private=owner

入力：scope=public|groups|mine、cursor、limit<=20、postId。

戻り値：閲覧権限のあるPostSummary[]とnextCursor／PostDetail。

失敗：401／404非公開または未所属

WHERE句でACLを適用してからlimit・集計・ページ分割。ブラウザで非公開分を隠すだけは禁止。非公開応答はno-store。

入力例：
```json
{
  "scope": "groups",
  "limit": 20
}
```
戻り例：
```json
{
  "items": [
    {
      "postId": "post_example",
      "postRevision": 1,
      "story": "金沢の旅行記録",
      "visibility": "group"
    }
  ],
  "nextCursor": null
}
```

## K15 投稿の公開範囲変更・削除

通信：PATCH /api/v1/posts/{id} または DELETE

権限：post owner。group変更時は所属も確認

入力：expectedPostRevision、visibility、groupId?、story?。

戻り値：200：postRevision、visibility／204削除。

失敗：409版競合／404所有権／422group不正

取り消しは次のサーバーアクセスから反映。既に閲覧者が保存した内容の回収は保証しない。元旅程削除は関連投稿を同時非公開にする初期方針。

入力例：
```json
{
  "expectedPostRevision": 1,
  "visibility": "private"
}
```
戻り例：
```json
{
  "postId": "post_example",
  "postRevision": 2,
  "visibility": "private"
}
```

## K16 他人の旅程を自分用に複製

通信：POST /api/v1/posts/{id}/copy

権限：認証＋コピー時点の閲覧権限

入力：旅行開始日、使用タイムゾーン、タイトル。

戻り値：201：自分所有の新tripId、revision=1、validationState=needs_revalidation。

失敗：404投稿閲覧不可／422日時不正

公開snapshotだけコピー。元の秘密メモ・自宅住所・権限・ownerIdは引き継がない。別日付の時刻表は再取得する。

入力例：
```json
{
  "newStartDate": "2026-11-10",
  "timeZone": "Asia/Tokyo"
}
```
戻り例：
```json
{
  "tripId": "trip_copy",
  "ownerId": "user_b",
  "revision": 1,
  "validationState": "needs_revalidation"
}
```

## K17 グループの作成・招待・脱退管理

通信：POST /api/v1/groups、/groups/{id}/invites、/group-invites/accept、DELETE /groups/{id}/members/{userId}

権限：作成=本人。招待・除外=group admin。承認=招待対象本人

入力：名前／期限付き招待／招待受諾／対象userId。

戻り値：groupId、inviteURL、membership、204。

失敗：403管理者でない／410期限切れ／409承認済み

招待tokenはハッシュ保存。除外直後の次のGETで404。グループ投稿に全メンバーの権限を埋め込まない。

入力例：
```json
{
  "groupId": "group_a",
  "targetUserId": "user_b"
}
```
戻り例：
```json
{
  "membership": "revoked"
}
```

## K18 しおりと外部サービスへの出力

通信：POST /api/v1/trips/{id}/exports（PDF）、GET /exports/{id}、/trips/{id}/ics、/maps-links

権限：trip owner。ファイル取得時にも権限確認

入力：tripId、expectedRevision、format=pdf|ics|maps。

戻り値：exportIdとstatus／許可済みPDF／ICS／Maps URL。

失敗：404権限／409版違い／422転載不可素材

PDFの非同期jobは共有サーバーの出力処理専用であり、Claude起動キューではない。Maps URLは保存済みリストへの自動登録とは違う。

入力例：
```json
{
  "tripId": "trip_example",
  "expectedRevision": 4,
  "format": "pdf"
}
```
戻り例：
```json
{
  "exportId": "export_example",
  "status": "queued"
}
```

## K19 現地ガイド・トイレ・避難情報

通信：GET /api/v1/guides / amenities

権限：公開情報。位置情報は必要最小限・短期

入力：範囲、種類、スポットID。GPSは本人同意後。

戻り値：説明、写真参照、番号付き地点、出典、取得日、dataStatus。

失敗：422範囲過大／503／未対応地域を明示

空集合と取得失敗を区別。指定避難所と指定緊急避難場所を分け、現在開設中と断定しない。

入力例：
```json
{
  "bbox": "<同意済み範囲>",
  "kind": "shelter"
}
```
戻り例：
```json
{
  "items": [],
  "dataStatus": "unavailable",
  "reason": "公式データ未接続"
}
```

## K20 DBの保存と応答

通信：SQLite prepared statement / transaction

権限：DBファイルに触れるのは共有サーバーのみ

入力：認可済みowner、expectedRevision、許可データ。

戻り値：rows、変更行数、保存ID、新revision。

失敗：SQLITE_BUSY／CONFLICT／constraint violation

WAL、foreign_keys=ON、busy_timeout、短いtransaction。AIや外部APIの応答待ち中はDB write lockを保持しない。

入力例：
```json
{
  "operation": "updateTrip",
  "id": "trip_example",
  "expectedRevision": 3
}
```
戻り例：
```json
{
  "rowsChanged": 1,
  "revision": 4
}
```

## K21 ローカル生成の取消

通信：POST /local/v1/jobs/{jobId}/cancel

権限：ローカル本人

入力：jobId＋CSRF。

戻り値：202取消受付（待機中・実行中のjob。state=cancelled）／200既に終了（現在のstateを返し、成功済みならbatchIdも返す）。

失敗：404所有権／409 ALREADY_COMMITTED（保存中、または再起動後に前回の結果を確認している途中。結果が確定していないのでbatchIdは返さない）

AbortSignalとプロセス終了を伝達。保存直前にも取消確認。保存確定済みなら取り消したと偽らずbatchを明示。成功済み（succeeded）の取消は200でstateとbatchIdを返す。

入力例：
```json
{
  "jobId": "job_example"
}
```
戻り例：
```json
{
  "jobId": "job_example",
  "state": "cancelled",
  "batchId": null
}
```

## K22 現在の利用可能機能

通信：GET /local/v1/capabilities または /api/v1/capabilities

権限：ローカル詳細は本人のみ

入力：認証状態と実行場所。

戻り値：aiGeneration.available・runner（none|fake|claude-code）・reason（SHARED_ENTRY_NO_PERSONAL_CLAUDE／CLAUDE_EXECUTION_DISABLED／CLI_NOT_FOUND／CLI_NOT_AUTHENTICATED／TERMS_NOT_CONFIRMED、利用可能ならnull）、storage、dataMode（実際のPROVIDER_MODE）、schemaVersion。

失敗：503依存停止

共有URLの利用者に自動Claude生成が利用できると表示しない。機能要件から削除するのではなく提供範囲の制約を明示する。

入力例：
```json
{}
```
戻り例：
```json
{
  "aiGeneration": {
    "available": false,
    "reason": "SHARED_ENTRY_NO_PERSONAL_CLAUDE"
  },
  "storage": "shared-server",
  "dataMode": "fixture",
  "schemaVersion": 1
}
```

## K23 エラーの共通形式

通信：全HTTP・内部関数の境界

権限：対象データの存在が漏れない応答

入力：例外とrequestId。秘密情報は入力ログに残さない。

戻り値：{code,message,retryable,requestId,details?}。

失敗：HTTP statusは401/403/404/409/410/422/429/500/502/503を使い分ける（ERROR_HTTP_STATUS）。ErrorCode：UNAUTHENTICATED、FORBIDDEN、NOT_FOUND、REVISION_CONFLICT、IDEMPOTENCY_CONFLICT、ALREADY_COMMITTED、EXPIRED、VALIDATION_FAILED、CONSTRAINT_UNSATISFIED、RATE_LIMITED、QUEUE_FULL、UNAVAILABLE、AI_UNAVAILABLE、CLI_NOT_AUTHENTICATED、CLI_LIMIT、CLI_TIMEOUT、CLI_EXIT、INVALID_OUTPUT、WORKER_RESTARTED、PROVIDER_UNAVAILABLE、PROVIDER_RATE_LIMIT、PROVIDER_UNSUPPORTED_REGION、RESTRICTED_ASSET、CANCELLED、INTERNAL。

429は無限リトライしない。CLI利用枠不足でAPI課金へ切り替えない。INTERNALは500、INVALID_OUTPUTは502。CLI_*・INVALID_OUTPUT・WORKER_RESTARTEDは通常HTTP応答ではなくJobStatus.errorに入る。

入力例：
```json
{
  "code": "REVISION_CONFLICT",
  "expectedRevision": 3,
  "currentRevision": 4
}
```
戻り例：
```json
{
  "code": "REVISION_CONFLICT",
  "message": "他の端末で更新されています。再読込して変更を確認してください。",
  "retryable": false,
  "requestId": "req_example"
}
```

## 本人入口の認証
本人PCのローカル画面は127.0.0.1:4311から配信。Host/Originを厳密に検証、外部CORSを許可しない。起動時に端末画面に出す短命・一度だけのペアリングコードと本人アプリ利用者を結び付ける。IPだけでは本人判定しない。
通常のアプリログインだけは固定共有URLへproxyする。上流アプリセッションは本人用サーバー内に保持し、ローカルブラウザには別のHttpOnlyローカルcookieを使う。ClaudeのOAuth tokenを読み出したり、このproxyへ載せたりしない。本人allowed user以外はCLIを使えない。
共有版はHTTPSでSecure cookie、HttpOnly、SameSite。localhostの開発例外を公開環境に持ち込まない。変更操作はCSRFも検証。共有APIには本人CLIへの逆proxy、共有ジョブをCLIが取得する仕組みを作らない。

## CLI実行
未改変公式CLI、固定実行ファイル、引数配列、shell:false、最小専用cwdを使用。promptはstdin。
--print/-p、--output-format json、--json-schema、--tools等は実機helpと試験で対応を固定する。--bareはサブスク認証を読み込まないため今回の既定にしない。通常-pで読み込まれるhooks/plugins/MCP/CLAUDE.md等を監査。ツール無効化だけで完全隔離できたとは判断しない。
認証方法、API課金環境変数やhelper、追加利用量を確認。不明なら実生成を止める。失敗時は勝手にAPI課金、他のアカウント、別モデルサービスへ切り替えない。stdoutのschema、終了コード、結果のエラー状態をすべて確認。プロセス終了、timeout、cancel、最大出力長を実装。

## 動作状態
job: queued→running→succeeded/failed/cancelled。succeededは候補の共通DB保存が完了してbatchIdを取得した状態。採用済みTripの意味ではない。候補採用は別操作。
初期負荷制限は同時1・待機8・全体300秒・CLI120秒。形式修復（INVALID_OUTPUT時の再実行1回）は未実装：Pro利用量が倍になるため、A04では実装せずINVALID_OUTPUTで失敗させる（#106）。初期設計値で性能保証ではない。ローカルApp Server再起動で途中jobは失敗。共有DBに候補保存済みならoperation keyから結果を確認し、重複保存を防ぐ。

## 実装で確定した事項（2026-10-24、M1）
契約の本文は上の各Kのとおりです。この節では、実装で細かく決めた点と、Kに無い補助ルートを記録します。

- **K11の本人入口**：
  - ブラウザは、端末に表示された一度限りのペアリングコードを`POST /local/v1/pair`に送り、ローカル用cookieを受け取ります。
  - その後`POST /local/v1/auth/login`が、共有サーバーの`/api/v1/auth/login`へ限定的に中継します。上流のcookieとCSRFはブラウザに渡しません。
  - ログインできるのは`PERSONAL_OWNER_USER_ID`の利用者だけです。
  - `GET /local/v1/session`で、ローカルセッションの状態を確認できます。
- **K01**：現時点ではbaseTripIdとexpectedRevisionを422で拒否します。共有サーバーでの所有確認をA04で実装するまでの措置です。replanも同様です。
- **K21**（A02、A03）：
  - キュー待ちと実行中のjobの取消は202 `cancelled`を返します。
  - 終了済みのjobには200で現在の状態を返し、保存済みならbatchIdも返します。
  - 成功済み（succeeded）の取消は200でstateとbatchIdを返します。
  - 保存中の取消と、再起動後に前回の結果を確認している途中の取消は409です。結果は確定していませんが、保存済みのbatchIdが判明している場合は`details.batchId`に入れて返します。
  - 保存が確定したか分からない失敗（`WORKER_RESTARTED`、保存中以降の失敗、前回結果の確認が終わっていないもの）は、同じIdempotency-Keyで再送します。サーバーは、保存済みの結果がないかを確認してから再試行します。operation keyが同じなので、重複して保存されません。
  - それ以外の失敗は、同じキーで再送すると同じjobの結果が返ります。生成をやり直すときは新しいキーを使います。
- **K07/K08**（S04）：
  - `PlanBatchCreate`は`constraints`を必須とします。
  - 保持期限を過ぎたbatchの読出しは410です。
  - 同じ`generationId`の再送は、同じ内容なら200、異なる内容なら409です。
  - `baseTripId`がnullのbatchを既存の旅程に適用しようとすると422です。
  - 差分の`unknownCostItems`には、編集前と編集後の両方の不明費用の項目を含めます（R11）。
- **K10の差分（TripDiff）**：サーバーの計算は`@tkb/planner`の`tripDiff`に一本化しています（`computeDiff`もこれを使います）。画面用モック（`apps/web/src/mocks`）はまだ旧定義のままです（tests/contracts/FINDINGS.md M-9）。
  - 費用：編集前と編集後のどちらかで費用が不明な項目は、`knownCostDelta`に含めず、`unknownCostItems`に入れます。不明な費用を節約や新たな出費として数えません（R11）。
  - `knownCostDelta`は通貨ごとの差額で、差が0の通貨は省きます。空の配列は「既知の変化がない」という意味で、「無料」ではありません。
  - 徒歩区間には運賃がないので、費用の項目として扱いません。
  - `durationDeltaSeconds`：旅程全体の開始から終了までの差です（日をまたぐ空き時間も含みます）。時刻が不明な項目が1つでもある場合と、項目が0件の場合はnullにします。
- **K18の「転載不可の素材」**（E03で決定）：ICS・Maps URL・PDFでは、利用条件で出力できない場所・写真・区間（`mayExport=false`）を除いて出力を続け、除いたものを`withheld`/`omitted`の一覧で返します。422にするのは、出力できる内容が1つもない場合だけです。出発地・帰着地（自宅）の名前は出力しません。
- **K18のPDF**（E02）：
  - `POST /api/v1/trips/{id}/exports`（本文は`ExportRequest`。`tripId`は省略可で、送る場合はパスと一致が必要。`format`は`pdf`のみ受け付け、他は422）→ 202 `ExportStatus`（`status=queued`、`withheld`に除いた項目）。
  - `GET /api/v1/exports/{id}`：完成していればPDF本体（`application/pdf`、`attachment; filename="trip-<tripId>.pdf"`、`no-store`）。未完成・失敗・期限切れは`ExportStatus`のJSON（実行中も`queued`、失敗は`error.code`に`TIMEOUT`等）。`DELETE /api/v1/exports/{id}`は204で、以後のGETは404です。
  - 作成も取得も旅程の所有者だけです。他人の旅程・exportと存在しないものは、どちらも404です。取得のたびに旅程の所有を確認するので、旅程を削除するとexportも404になります。版違いは409 `REVISION_CONFLICT`、出力できる項目が1つもない場合は422 `RESTRICTED_ASSET`です。
  - 生成は共有サーバー内の固定レイアウト（pdf-lib＋同梱のNoto Sans JP、OFL-1.1、subset埋込み）で行います。ブラウザ・HTML・任意URLは読み込みません。地図画像と写真は描画しません（写真は外部URLのため。件数だけ注記）。不明な値は「未定」「不明」と書き、0にしません。JIS第1・第2水準外の文字は「?」になります。
  - 出力jobはメモリ上のキューで、同時実行1件、待機8件まで（超えると429 `QUEUE_FULL`）、利用者ごとに処理中1件（429 `RATE_LIMITED`）、1件20秒で`failed`（TIMEOUT）、完成したPDFは10分で破棄（`expired`）します。ディスクには書かず、再起動で消えます。ICS・Maps URL（E03）は`@tkb/exports`の関数で、このルートでは返しません。
- **K19の周辺施設**（U07、D08）：`GET /api/v1/amenities?bbox=south,west,north,east&kind=...`。認証は不要（公開情報）で、応答はすべて`no-store`です。位置は保存もログ出力もしません。
  - bboxが不正、`kind`や災害種別が不明、範囲が大きすぎる場合は422です。
  - 取得元が使えない場合（liveは未実装）は503 `UNAVAILABLE`（再試行可）です。
  - 未対応の地域は、空の`ok`にせず200で`dataStatus=unsupported_region`を返します。対応範囲で施設が無い場合は200・`items=[]`です。
  - `openNow`は常にnullです。指定されていることは、現在開設中であることを意味しません。
  - `GET /api/v1/guides`（スポット説明）は登録していません。説明は`Trip.places`で渡ります。
- **互換の追加（schemaVersion 1のまま）**：
  - `TripConstraints.transportModeByDate`（R6、日ごとの交通手段。指定のない日は`transportMode`を使う。公開snapshotにも含める）
  - `TravelLeg.transit`（R05、乗車駅・降車駅・乗換駅の名前。取得できなければ`null`または空配列で、推測しない）
- **K12/K15**：グループが存在しない場合と非所属の場合は、どちらも422にします（グループの存在を漏らさないため）。K13の確定時に所属を失っていた場合は404です。
- **K14**：
  - 匿名で読めるのは`scope=public`と公開投稿の詳細だけです。
  - 閲覧できない投稿と存在しない投稿は、どちらも404にします。
  - 応答はすべて`no-store`です。
- **K17**：招待tokenはURLのフラグメント（`/invite#<token>`）に入れます。除外された利用者宛ての未使用の招待は、除外と同時に無効にします。
- **共有入口の公開（O01）**：`/local/*`は、共有入口では大文字小文字やエンコードの違いを含めて常に404です。共有サーバーは子プロセスを起動しません。
- **A04の生成（#106、#108）**：
  - K05はDBへ保存せず、要求内容をログに残しません。利用者ごとの上限（同時1件、1日`PLANNING_CONTEXT_DAILY_PER_USER`件）は429 RATE_LIMITED、外部APIの上限は429 PROVIDER_RATE_LIMITで、両者を区別します。
  - K07は、候補が参照する地点IDが`places`にないbatchを422 VALIDATION_FAILEDで拒否します。K07へPOSTするのは本人用App Serverだけで、Webはbatchを読むだけ（GET）なので、Webの画面とmockには影響しません。
  - 形式修復（INVALID_OUTPUT時の再実行1回）は実装していません。Pro利用量が倍になるためです（「動作状態」参照）。
  - 既知の制約（reviewer O3）：liveモードでは2回目のK05で地点検索をもう一度行うため、呼出し回数に余裕がありません。デモはmixedで行います。
  - 既知の制約（reviewer O7）：時刻のない立ち寄り先は、1日にまとめて配置されます。
  - 既知の差：本人用App Serverのcapabilitiesは`dataMode=fixture`を固定で返します（A05で修正予定）。
- **A05の代替案（#114）**：型は`packages/contracts`の`AlternativesRequest`／`AlternativesResult`（K10の拡張、schemaVersion 1のまま）。既知の制約：`reorder`の案は、1日の終わりを23:59とみなして詰めて並べます（案の説明に「詰めた案」と明記）。宿の到着時刻などの実際の終了時刻は、まだ考慮していません。
- **A06の再計画（#118）**：型は`packages/contracts`の`ReplanRequest`／`ReplanResult`（K10の拡張、schemaVersion 1のまま）。既知の制約：その日の23:59までしか組み直さず、入りきらない予定は時刻なしで残します（翌日へは移しません）。0:00〜4:00の「経路なし」は終電後と判定しません。AIで残りを作り直すK01 replan（A06b）は後回しです。
