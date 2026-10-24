# 入出力契約 v4

自作アプリの実装先契約。まだ稼働しているAPIではない。数値とIDは説明用。正本はmodel/contracts.json。

**実装（B02）**：Zod v4のschema v1を`packages/contracts`に置いた。表現の決まり、資料間の食い違いの解決、破壊的変更の手順は`packages/contracts/README.md`を参照。2026-10-24時点で稼働しているのは`/api/v1/health`、`/api/v1/capabilities`（:4310）、`/local/v1/health`、`/local/v1/capabilities`（:4311）だけ。

## K01 本人の旅程生成受付

通信：POST /local/v1/generations

権限：ローカルセッション＋Host/Origin/CSRF＋本人所有権

入力：GenerateRequest：constraints、baseTripId?、expectedRevision?。Idempotency-Keyヘッダー。ownerIdは受け付けない。

戻り値：202 JobAccepted：jobId、state=queued、pollAfterMs。完成した旅程はこの応答に含めない。

失敗：401本人未認証／403利用不可／409同じキーで入力違い／422入力不正／429待機上限

数値とIDは説明用。本人の操作だけを受付。共有サーバーや公開ユーザーの生成依頼は転送しない。

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

戻り値：200 JobStatus：state、stage、batchId?、error?。成功時の候補本体は共通DBのbatchIdから取得。

失敗：404他人または不存在／503本人App Server停止

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
  "state": "succeeded",
  "stage": "saved",
  "batchId": "batch_example",
  "error": null
}
```

## K03 Claude Codeへの生成依頼と戻り値

通信：子プロセス：stdin / stdout(JSON) / stderr / exit code

権限：PC所有者の未改変公式Claude Code認証

入力：GenerationInput：旅行条件、利用許諾済みの事実、候補ID、固定予定、出力Schema。任意shellコマンドは含めない。

戻り値：CLI envelope内のstructured_outputをSchema検証したPlanBlueprint。自然文をそのままTripとして保存しない。

失敗：CLI_NOT_AUTHENTICATED／CLI_LIMIT／CLI_TIMEOUT／CLI_EXIT／INVALID_OUTPUT

構造化出力でも真実性は保証されない。stdoutの成功フラグ、終了コード、Schemaを別々に確認。

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

入力：旅行条件、候補範囲、対象地点ID、移動モード。上限付き。

戻り値：PlanningContext：候補、移動情報、出典、取得時刻、利用許諾、unknown値。

失敗：401／422／429外部利用上限／503データ取得不可

実際の外部データをAIへ渡せるかは情報源別に判定。禁止・不明ならその値を除外し、生成後のプログラム照合だけに使う。

入力例：
```json
{
  "area": "金沢",
  "transportMode": "transit",
  "maxPlaces": 8
}
```
戻り例：
```json
{
  "places": [
    {
      "ref": "user-place-a",
      "source": "fixture",
      "maySendToModel": true
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

通信：POST /api/v1/plan-batches / GET /api/v1/plan-batches/{id}

権限：アプリ本人セッション。AI認証とは無関係

入力：GenerationResult：候補、制約、根拠、baseTripId?、baseRevision?、ローカル生成識別子。

戻り値：201：batchId、candidateIds、検証結果。全候補の保存先は共通DB。

失敗：401／404所有権／409元旅程変更／422不正候補

サーバーでも型・所有権・データ保持条件を検証。クライアントが付けた「Claude生成」等のラベルを権限の証拠にしない。

入力例：
```json
{
  "schemaVersion": 1,
  "baseTripId": null,
  "baseRevision": null,
  "candidates": [
    {
      "candidateId": "candidate_1",
      "activities": [],
      "warnings": [
        "説明用データ"
      ]
    }
  ]
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

入力：batchId、candidateId、tripId?、expectedRevision?。

戻り値：201新規／200更新：tripId、revision、Trip、warnings。

失敗：404候補の所有権／409古い版／422未検証

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
  "warnings": []
}
```

## K09 保存済み旅程の読出し

通信：GET /api/v1/trips または /api/v1/trips/{id}

権限：セッションownerId

入力：ページ条件またはtripId。

戻り値：自分のTrip一覧／TripDetail。公開他人旅程はPost経由で読む。

失敗：401／404他人または不存在

別端末でも同じアプリ利用者なら同じサーバーデータを参照。DBファイルは端末間でコピーしない。

入力例：
```json
{
  "tripId": "trip_example"
}
```
戻り例：
```json
{
  "tripId": "trip_example",
  "ownerId": "user_a",
  "revision": 1,
  "days": []
}
```

## K10 編集保存と版競合

通信：PATCH /api/v1/trips/{id}

権限：旅程のowner

入力：expectedRevision、operations（追加・削除・移動・変更）。

戻り値：200：新revision、更新旅程、時間差、既知費用差、warnings。

失敗：409 REVISION_CONFLICT／422制約不成立／404所有権

APIで差分を許可リスト検証。公開の手動編集はClaude不要。AIで残りを作り直す操作はK01経由。

入力例：
```json
{
  "expectedRevision": 3,
  "operations": [
    {
      "op": "remove",
      "activityId": "activity_b"
    }
  ]
}
```
戻り例：
```json
{
  "tripId": "trip_example",
  "revision": 4,
  "warnings": [
    "移動情報を再確認してください"
  ]
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

戻り値：202取消受付／200既に終了。

失敗：404所有権／409保存確定後

AbortSignalとプロセス終了を伝達。保存直前にも取消確認。保存確定済みなら取り消したと偽らずbatchを明示。

入力例：
```json
{
  "jobId": "job_example"
}
```
戻り例：
```json
{
  "state": "cancelled"
}
```

## K22 現在の利用可能機能

通信：GET /local/v1/capabilities または /api/v1/capabilities

権限：ローカル詳細は本人のみ

入力：認証状態と実行場所。

戻り値：aiGeneration.availableとreason、storage、dataMode、schemaVersion。

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

失敗：HTTP statusは401/403/404/409/410/422/429/503を使い分ける

429は無限リトライしない。CLI利用枠不足でAPI課金へ切り替えない。

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
初期負荷制限は同時1・待機8・全体300秒・CLI120秒・修復1回。初期設計値で性能保証ではない。ローカルApp Server再起動で途中jobは失敗。共有DBに候補保存済みならoperation keyから結果を確認し、重複保存を防ぐ。

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
  - 保存中の取消と、再起動後に前回の結果を確認している途中の取消は409です。結果が確定していないため、batchIdは返しません。
  - 失敗したjobを再試行するときは、新しいIdempotency-Keyで送ります。同じキーなら同じjobの結果が返ります。
- **K07/K08**（S04）：
  - `PlanBatchCreate`は`constraints`を必須とします。
  - 保持期限を過ぎたbatchの読出しは410です。
  - 同じ`generationId`の再送は、同じ内容なら200、異なる内容なら409です。
  - `baseTripId`がnullのbatchを既存の旅程に適用しようとすると422です。
  - 差分の`unknownCostItems`には、編集前と編集後の両方の不明費用の項目を含めます（R11）。
- **K12/K15**：グループが存在しない場合と非所属の場合は、どちらも422にします（グループの存在を漏らさないため）。K13の確定時に所属を失っていた場合は404です。
- **K14**：
  - 匿名で読めるのは`scope=public`と公開投稿の詳細だけです。
  - 閲覧できない投稿と存在しない投稿は、どちらも404にします。
  - 応答はすべて`no-store`です。
- **K17**：招待tokenはURLのフラグメント（`/invite#<token>`）に入れます。除外された利用者宛ての未使用の招待は、除外と同時に無効にします。
- **共有入口の公開（O01）**：`/local/*`は、共有入口では大文字小文字やエンコードの違いを含めて常に404です。共有サーバーは子プロセスを起動しません。
