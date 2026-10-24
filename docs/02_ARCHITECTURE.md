# C4システム設計 v4

すべて設計目標であり、実装済みと表示しない。人間はSYSTEM_DESIGN.htmlで図を見る。staticモデルのIDを動的図で再利用し、図と契約を別々に書き直さない。

## C1｜旅行Webシステムの外側
対象：旅行Webシステム。各線の実線は依頼、破線はその依頼への応答。図の箱・矢印を選ぶと入力と戻り値を確認できます。
図：assets/context.svg。要素：owner, other, travel, anthropic, providers, maps

## C2｜画面・2つのサーバー・DB・Claude
対象：travel。本人用と共有用の入口を分離。共有サーバーから本人用CLIへの起動経路は作りません。ポート番号は今回の設計値。
図：assets/containers.svg。要素：web-local, web-shared, personal, shared, db, cli, anthropic, providers, maps

## C3｜本人用App Serverの内部
対象：personal。受付は202で先に返します。処理完了後は候補を共通DBへ保存し、ブラウザの状態照会にbatchIdを返します。
図：assets/local-components.svg。要素：web-local, gate, job, shared-client, claude-adapter, validator, shared, cli

## C3｜共有サーバーとSNSの内部
対象：shared。SNSは単なる共有リンクではありません。投稿snapshot、現時点のグループ所属、旅程複製、所有権を共有サーバーで管理します。
図：assets/shared-components.svg。要素：web-shared, auth, trips, social, groups, data-api, exports, repository, db, providers

## C3｜SNSの責任分担だけを拡大
対象：shared。SNS投稿とグループ認可の部分だけを抽出した同じC3モデル。別システムではありません。
図：assets/social-focus.svg。要素：web-shared, auth, social, groups, repository, db

## 構成要素

### owner / 利用者本人
種類：Person。技術：。親：None
責任：PCで条件を指定し、Claude生成・採用・共有を行う
入力：
出力：
担当：。予定path：


### other / SNS利用者
種類：Person。技術：。親：None
責任：公開・グループ旅程を読み、手動編集・複製を行う
入力：
出力：
担当：。予定path：


### travel / 旅行Webシステム
種類：Software System。技術：Web application。親：None
責任：生成・旅程保存・地図・SNSをまとめる
入力：
出力：
担当：。予定path：


### anthropic / Claudeサービス
種類：External Software System。技術：Anthropic hosted。親：None
責任：公式Claude Codeの依頼から旅程候補を生成
入力：
出力：
担当：。予定path：
モデルはAnthropic側で実行。PC上のローカルLLMではない。

### providers / 旅行情報サービス
種類：External Software System。技術：HTTPS。親：None
責任：地点・時刻・移動・画像等を供給
入力：
出力：
担当：。予定path：
地域差、費用、保存・転載・LLM入力可否を確認して使う。

### maps / 地図表示サービス
種類：External Software System。技術：Maps JavaScript SDK。親：None
責任：地図タイル・ベース地図を表示
入力：
出力：
担当：。予定path：
ブラウザ用キーはreferrer/API制限。サーバー秘密キーとは分ける。

### web-local / 本人用Web画面
種類：Container。技術：React / TypeScript。親：travel
責任：条件入力、生成進捗、候補の比較と採用
入力：
出力：
担当：M2。予定path：apps/web/
本人PCの127.0.0.1:4311で配信。共有版と同じUIコードをcapabilitiesで切替。

### web-shared / 共有Web画面
種類：Container。技術：React / TypeScript。親：travel
責任：旅程閲覧、編集、SNS、ガイド
入力：
出力：
担当：M2。予定path：apps/web/
HTTPS共有URLから利用。第三者のClaude生成をホストのProへ中継しない。

### personal / 本人用App Server
種類：Container。技術：Node.js / Fastify。親：travel
責任：本人の生成ジョブ・CLI起動・結果検証
入力：
出力：
担当：M4。予定path：apps/ai-local/
127.0.0.1:4311のみ。端末本人の操作を受け、取得/保存は共有APIに依頼。DBを直接開かない。

### shared / 共有アプリサーバー
種類：Container。技術：Node.js / Fastify。親：travel
責任：認証、旅程、SNS、外部データ、永続化
入力：
出力：
担当：M1 + M4。予定path：apps/server/
127.0.0.1:4310。公開ルートはこれだけ。実行キューからClaudeを起動する機能を置かない。

### db / 共通データベース
種類：Container。技術：SQLite / WAL。親：travel
責任：全利用者の旅程・SNS・認可情報を永続保存
入力：
出力：
担当：M1。予定path：data/travel.sqlite
ホストPC内のサーバーファイル。Gitに入れず、ネットワーク共有ドライブに置かない。

### cli / 公式Claude Code
種類：External Software System。技術：Claude Code CLI。親：None
責任：本人の認証でClaudeに依頼しJSONを返す
入力：
出力：
担当：PC所有者。予定path：OS installation / fixed runtime cwd
未改変の公式CLI。アプリがOAuth tokenを抽出・保存・移送しない。非対話利用条件と実機動作をA01で確認。

### gate / 本人確認と入力受付
種類：Component。技術：Fastify handlers。親：personal
責任：Host・Origin・CSRF・所有権・入力を検証
入力：GenerateRequest / ReplanRequest
出力：JobAccepted / Error
担当：M4。予定path：apps/ai-local/src/routes/


### job / 生成ジョブ管理
種類：Component。技術：TypeScript / memory。親：personal
責任：順序、重複、取消、進捗、時間制限
入力：validated request
出力：jobId / state / batchId
担当：M4。予定path：apps/ai-local/src/jobs/
再起動時の未完了ジョブはWORKER_RESTARTED。旅程候補は共有DBに保存後のみ成功とする。

### shared-client / 共有APIクライアント
種類：Component。技術：HTTP client / app session。親：personal
責任：本人権限でデータを取得・候補を保存
入力：constraints / candidate batch
出力：planning context / batchId
担当：M4。予定path：apps/ai-local/src/shared-client/
接続先は設定済み共有URLの許可パスのみ。任意URL proxy禁止。

### claude-adapter / Claude接続アダプター
種類：Component。技術：Node child_process。親：personal
責任：安全にCLIを起動し構造化出力を解析
入力：GenerationInput + JSON Schema
出力：PlanBlueprint / typed error
担当：M4。予定path：packages/ai/
shell:false、固定実行ファイル、stdin、上限、タイムアウト。開発用Agentとは別プロセス・別cwd。

### validator / 旅程検証
種類：Component。技術：TypeScript pure functions。親：personal
責任：形式・経路・日時・固定予定・予算を照合
入力：blueprint + allowed facts
出力：validated candidates / issues
担当：M3 + M4。予定path：packages/planner/
AIが候補順を生成し、プログラムが制約を検証。運賃やホームを生成で穴埋めしない。

### auth / 認証・認可
種類：Component。技術：Fastify / session。親：shared
責任：利用者を特定し所有権・所属を検証
入力：app cookie + resource IDs
出力：ActorContext / denied
担当：M1。予定path：apps/server/src/auth/


### trips / 旅程API
種類：Component。技術：TypeScript。親：shared
責任：下書き・候補・採用・編集・版管理
入力：Trip / batch / expectedRevision
出力：tripId + revision / conflict
担当：M4。予定path：apps/server/src/trips/


### social / SNS投稿API
種類：Component。技術：TypeScript。親：shared
責任：プレビュー、安全化snapshot、公開・閲覧・複製
入力：tripRef / previewToken / visibility
出力：Post / filtered feed / new trip
担当：M1。予定path：apps/server/src/social/


### groups / グループAPI
種類：Component。技術：TypeScript。親：shared
責任：招待・所属・除外の管理
入力：groupId + invite / membership command
出力：membership / forbidden
担当：M1。予定path：apps/server/src/groups/


### data-api / 旅行情報API
種類：Component。技術：Provider adapters。親：shared
責任：地点・区間・ガイド・周辺施設を取得
入力：area / place IDs / departure
出力：normalized facts + provenance
担当：M3。予定path：packages/travel-data/


### exports / しおり・予定出力
種類：Component。技術：HTML print / ICS。親：shared
責任：認可済み旅程をPDF・ICS・地図リンクへ変換
入力：tripRef + expectedRevision
出力：exportId / authorized file / URL
担当：M2 + M1。予定path：packages/exports/


### repository / 永続化Repository
種類：Component。技術：SQLite prepared SQL。親：shared
責任：認可済みの読み書きと版transaction
入力：query / expectedRevision / records
出力：rows / saved ID / conflict
担当：M1。予定path：packages/db/
全テーブルの唯一の書込み窓口。DB schema変更はM1が統合。

## 全通信関係

### R-L1a
owner → travel：旅行条件・生成・採用・公開指示
travel → owner：候補・保存旅程・警告
通信：Web操作。契約：K01


### R-L1b
other → travel：投稿閲覧・複製・手動編集
travel → other：許可された投稿・自分の旅程
通信：Web操作。契約：K14


### R-L1c
travel → anthropic：本人の公式CLI経由：生成条件と許諾済み事実
anthropic → travel：旅程候補・理由・警告
通信：公式CLIのHTTPS。契約：K04


### R-L1d
travel → providers：地点・区間・日時の照会
providers → travel：地点・時刻・運賃・出典／未取得
通信：HTTPS。契約：K06


### R-L1e
travel → maps：表示領域と地図設定
maps → travel：ベース地図・帰属表示
通信：SDK / HTTPS。契約：K06


### R01
web-local → personal：生成・状態照会・認可済み通常API
personal → web-local：jobId／状態／旅程・投稿・エラー
通信：HTTP / JSON :4311。契約：K01


### R02
web-shared → shared：ログイン・旅程・SNS操作
shared → web-shared：Trip／Post／権限付き結果
通信：HTTPS / JSON。契約：K14


### R03
personal → shared：本人セッションで情報取得・候補保存・通常API
shared → personal：旅行情報／batchId／Trip／Post
通信：HTTP(S) / JSON。契約：K07
公開sharedからpersonalへの呼出しは存在しない。往復の戻りはpersonalが始めた要求への応答のみ。

### R04
personal → cli：旅行条件＋候補ID＋出力Schema
cli → personal：stdout構造化JSON／exit code
通信：stdin / stdout / process。契約：K03


### R05
cli → anthropic：公式CLI管理の生成依頼
anthropic → cli：Claudeの候補出力・利用上限
通信：HTTPS / managed by CLI。契約：K04


### R06
shared → db：認可後のSQL・版付き更新
db → shared：行・保存ID・新revision／競合
通信：SQLite / in-process。契約：K20


### R07
shared → providers：地点・経路・日時の照会
providers → shared：正規化前のデータ・出典／未取得
通信：HTTPS。契約：K06


### R08
web-local → maps：地図表示領域
maps → web-local：地図・帰属表示
通信：SDK / HTTPS。契約：K06


### R09
web-shared → maps：地図表示領域
maps → web-shared：地図・帰属表示
通信：SDK / HTTPS。契約：K06


### L01
web-local → gate：生成要求・CSRF
gate → web-local：202 JobAccepted／Error
通信：HTTP / JSON。契約：K01


### L02
gate → job：検証済み本人要求・入力ハッシュ
job → gate：jobId・state／重複応答
通信：function call。契約：K01


### L03
job → shared-client：planning context照会・結果保存
shared-client → job：許諾済み事実／batchId
通信：function / Promise。契約：K05


### L04
shared-client → shared：アプリ本人セッション＋型付き要求
shared → shared-client：旅行情報・保存済み候補
通信：HTTP(S) / JSON。契約：K07


### L05
job → claude-adapter：GenerationInput・AbortSignal
claude-adapter → job：PlanBlueprint／typed error
通信：Promise。契約：K03


### L06
claude-adapter → cli：固定引数＋stdin prompt
cli → claude-adapter：stdout envelope／stderr／exit code
通信：child_process。契約：K03


### L07
job → validator：候補順・固定予定・実データ
validator → job：検証済み候補・warnings
通信：function / Promise。契約：K07


### C01
web-shared → auth：cookie・CSRF・対象操作
auth → web-shared：ActorContext／401・403
通信：HTTP / middleware。契約：K11


### C02
auth → trips：本人context＋旅程操作
trips → auth：Trip／batch／409
通信：function call。契約：K08


### C03
auth → social：本人context＋投稿操作
social → auth：Post／Feed／404
通信：function call。契約：K13


### C04
auth → groups：本人context＋招待操作
groups → auth：membership／403
通信：function call。契約：K17


### C05
auth → data-api：範囲・日時・上限制約
data-api → auth：facts／unknown／503
通信：function call。契約：K05


### C06
auth → exports：tripRef＋所有権context
exports → auth：exportId／authorized URL
通信：function call。契約：K18


### C07
auth → repository：セッション・認可照会
repository → auth：userId・owner・membership
通信：SQL abstraction。契約：K20


### C08
trips → repository：候補・旅程・expectedRevision
repository → trips：savedId・revision／409
通信：transaction。契約：K20


### C09
social → repository：ACL付き投稿query・snapshot保存
repository → social：許可された投稿／savedId
通信：transaction。契約：K20


### C10
groups → repository：招待・所属のqueryと更新
repository → groups：membership／constraint error
通信：transaction。契約：K20


### C11
exports → repository：旅程と出力物の所有権照会・記録
repository → exports：Trip／exportRef
通信：SQL abstraction。契約：K20


### C12
repository → db：prepared SQL＋parameters
db → repository：rows／affected rows
通信：SQLite。契約：K20


### C13
data-api → providers：サービスごとの検索条件
providers → data-api：provider response／error
通信：HTTPS。契約：K06


### C14
trips → data-api：変更区間・出発時刻・交通手段
data-api → trips：再取得経路とwarnings
通信：function call。契約：K06
