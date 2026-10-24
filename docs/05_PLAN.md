# タスクグラフ v4

ops/tasks.jsonが定義の正本。hard dependencyは先行作業のPR統合と受入確認を意味する。UI prototypeは実Claude/Googleを待たない。backendはU02を前提にしない。

## B01 既存tkb_2627リポジトリの接続と環境の事前確認
担当：M1。branch：feat/m1/b01。UI依存：none
前提：なし
要件：。契約：
変更path：scripts/doctor.mjs, docs/10_OPEN_ITEMS.md
完了：既存リポジトリと各PCの状況を記録し、外部認証不足を独立した阻害要因として分離する。
検証：Node、Git、Claude、gh、ホスト資源を検出。秘密情報を出力しない。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## B02 共通データ契約の最小版
担当：M1。branch：feat/m1/b02。UI依存：none
前提：B01
要件：R01, R07, R25, R28。契約：K01, K03, K07, K13, K20, K23
変更path：packages/contracts/, docs/03_CONTRACTS.md
完了：旅程、地点、時間、費用、ジョブ、公開範囲のSchema v1を公開する。
検証：正常／不正JSONの型と実行時検証。破壊的変更の管理方法を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## B03 WebとAPIの動く骨格
担当：M1。branch：feat/m1/b03。UI依存：none
前提：B01
要件：R25, R29。契約：
変更path：package.json, package-lock.json, apps/server/src/platform/, apps/web/src/main.tsx
完了：初期画面、API health、開発proxy、ビルド、起動コマンドが動く。
検証：別ディレクトリから再セットアップして画面とhealthを確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## B04 共通フィクスチャと画面用APIモック
担当：M2。branch：feat/m2/b04。UI依存：none
前提：B02, B03
要件：R29。契約：K01, K02, K08, K14
変更path：packages/fixtures/, apps/web/src/mocks/
完了：国内／海外のサンプルがSchemaに適合し、モック表示であることを明示する。初期サンプル（金沢・パリ）はM1がB02でpackages/fixturesに作成済み。M2は画面用APIモック（apps/web/src/mocks）と不足ケース（空・失敗・待機・予算不明等）を追加する。
検証：実APIキーなしで入力、表示、編集の画面試験が実行できる。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## B05 自動検証と秘密情報検出
担当：M1。branch：feat/m1/b05。UI依存：none
前提：B02, B03
要件：R30。契約：
変更path：.github/workflows/, scripts/check.mjs, tests/contracts/
完了：lint、型、単体、ビルドのCIを用意し、課金APIを通常CIから呼ばない。
検証：意図した失敗と秘密情報候補でCIが検知する。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## G01 既存GitHubの接続と3人の招待
担当：M1。branch：feat/m1/g01。UI依存：none
前提：B01
要件：。契約：
変更path：.local/team.json, docs/06_SETUP.md
完了：所有者が招待し、3人が承認。各自の認証と書込み権限を確認する。
検証：既存remote照合。各自の作業ブランチに検証commitをpush。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## G02 タスクのIssue化と共有ボード
担当：M1。branch：feat/m1/g02。UI依存：none
前提：G01, B02
要件：。契約：
変更path：ops/, scripts/github-sync.mjs, dashboard/
完了：GitHub Issueをタスクの唯一の進捗正本にし、M1が担当と共有ファイル作業を調整。依存リンク・状態・PR証拠・同期時刻を4人で確認する。
検証：2回初期化してIssue数が増えず、状態変更をダッシュボードへ反映。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U01 最初のクリック可能なUI
担当：M2。branch：feat/m2/u01。UI依存：prototype
前提：B04
要件：R01, R08, R29。契約：
変更path：apps/web/src/screens/, apps/web/src/components/
完了：条件入力、比較、編集、ガイド、共有への導線を実際に操作できる。
検証：スマートフォン幅で確認しスクリーンショットを記録。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U02 人間によるUIの初回レビュー
担当：M2。branch：feat/m2/u02。UI依存：approval
前提：U01
要件：R29。契約：
変更path：docs/ui-review/
完了：画面上の指摘と判断を記録し、受渡し型を変える指摘だけM1に通知する。
検証：利用者が触って指摘した内容と対応Issueを記録。バックエンド作業は待たせない。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D01 旅行情報の実接続と利用条件検証
担当：M3。branch：feat/m3/d01。UI依存：none
前提：B01
要件：R02, R05, R06, R30。契約：K06
変更path：docs/provider-probe.md, packages/travel-data/probes/
完了：対象地域で地点、車、公共交通を少量取得し、欠落と保存／AI利用条件を記録する。
検証：取得時刻、地域、日付、SKU、取得不可フィールドを残す。キー未提供はblocked。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D02 出典と課金回数の制限基盤
担当：M3。branch：feat/m3/d02。UI依存：none
前提：B02, D01
要件：R11, R30。契約：K06
変更path：packages/travel-data/src/policy/
完了：入力ごとの呼出上限とキャンセルを実装し、保存可能な内容を分類する。
検証：連打、無限再試行、矩形の要素数、期限切れをテスト。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D03 観光地と飲食店の取得
担当：M3。branch：feat/m3/d03。UI依存：none
前提：B02, D02
要件：R02, R10, R13, R15。契約：K05, K06
変更path：packages/travel-data/src/places/
完了：実在地点、写真、近隣候補、営業時間の取得値と不明値を返す。
検証：国内外の代表地点、営業時間欠落、失効写真、帰属表示を検証。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D04 公共交通と自動車の経路取得
担当：M3。branch：feat/m3/d04。UI依存：none
前提：B02, D02
要件：R05, R06。契約：K06
変更path：packages/travel-data/src/routes/
完了：区間と出発時刻を指定して経路、時刻、運賃、不明理由を返す。
検証：乗換、最終便、運賃なし、対応外地域、日付範囲外を検証。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D05 日時と通貨の共通計算
担当：M3。branch：feat/m3/d05。UI依存：none
前提：B02
要件：R07, R11。契約：K10
変更path：packages/planner/src/time/, packages/planner/src/money/
完了：IANAタイムゾーン、日跨ぎ、夏時間、不明費用、通貨別合計を扱う。
検証：日本と海外、夏時間重複／欠落、JPYとEUR、為替未設定を単体テスト。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D06 旅程の決定的な検証と順序調整
担当：M3。branch：feat/m3/d06。UI依存：none
前提：B02, B04, D05
要件：R03, R04, R11, R13。契約：K05, K07
変更path：packages/planner/src/schedule/
完了：固定条件と自由時間を保持し、成立可否と違反条件を返す。
検証：モック経路でも営業時間、移動時間、必須地点の矛盾を検出する。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D07 観光解説と利用可能な写真
担当：M3。branch：feat/m3/d07。UI依存：none
前提：B02, D02
要件：R15, R16。契約：K19
変更path：packages/travel-data/src/guides/
完了：許諾済み情報源から出典、説明、写真の権利情報を返す。
検証：HTML除去、画像権利欠落、外部URL制限、出典表示を検証。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## D08 トイレと公的避難情報
担当：M3。branch：feat/m3/d08。UI依存：none
前提：B02, D02
要件：R23, R24。契約：K19
変更path：packages/travel-data/src/amenities/
完了：情報の種類、取得日、対応地域、不明状態を返す。
検証：避難場所と避難所、災害種別、国外未対応、0件と取得失敗を区別。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## S01 サーバーDBとmigration
担当：M1。branch：feat/m1/s01。UI依存：none
前提：B02, B03
要件：R25, R26。契約：K20
変更path：packages/db/
完了：SQLiteのWAL、外部キー、版番号、migration、永続ディレクトリを構築する。
検証：再起動後保持、rollback、同時書込み待機、DBをGitに含めないことを確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## S02 認証とセッション管理
担当：M1。branch：feat/m1/s02。UI依存：none
前提：S01
要件：R26, R30。契約：K11
変更path：apps/server/src/platform/auth/
完了：招待制の利用者作成、ログイン、ログアウト、認可基盤が動く。
検証：cookie、CSRF、ログイン制限、権限外アクセス、秘密情報ログを検証。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## S03 グループと所属の管理
担当：M1。branch：feat/m1/s03。UI依存：none
前提：S02
要件：R21, R26。契約：K17
変更path：apps/server/src/social/groups/
完了：グループ管理者が招待／除外し、閲覧時点の所属を確認する。
検証：除外後の既存URL、招待の再使用、非管理者の操作を拒否。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## S04 旅程の保存と版管理API
担当：M4。branch：feat/m4/s04。UI依存：none
前提：S01, S02
要件：R09, R25。契約：K07, K08, K09, K10
変更path：apps/server/src/trips/
完了：K07〜K10の候補保存・採用・読出し・編集を実装し、TripとSNSと候補を共通サーバーへ永続化。別ownerと版競合を拒否。
検証：2ブラウザの競合、他人のID、削除後参照、再起動後の保存確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## S05 SNS投稿と公開スナップショット
担当：M1。branch：feat/m1/s05。UI依存：none
前提：S03, S04
要件：R20, R21。契約：K12, K13, K14, K15
変更path：apps/server/src/social/posts/
完了：K12〜K15の公開プレビュー、安全化snapshot、元版の再確認、フィードのサーバーACL、公開解除を実装。
検証：別ユーザーからのフィード／直接URL／写真／PDFの権限を検証。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## S06 旅程のコピーと再利用
担当：M1。branch：feat/m1/s06。UI依存：none
前提：S05, D05
要件：R22。契約：K16
変更path：apps/server/src/social/copy/
完了：閲覧可能な内容だけを自分の旅程へコピーし、新日付は再検証待ちとする。
検証：所有者変更、private内容除外、元データ非破壊、時刻再利用禁止を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## A01 本人のClaude Code接続と利用条件の確認
担当：M4。branch：feat/m4/a01。UI依存：none
前提：B01
要件：R27。契約：K03, K04
変更path：docs/claude-connection-check.md, packages/ai/probes/
完了：公式CLIと本人のサブスク認証、利用条件、非対話JSON出力を確認し、実行可否と制約を記録する。本人のローカル試験と第三者向けサービスを区別する。
検証：claudeの版とhelp、認証方式、最小1回の構造化出力、失敗理由を秘密情報なしで記録。API課金や認証回避への変更は禁止。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## A02 Claude Code用ローカルApp Server
担当：M4。branch：feat/m4/a02。UI依存：none
前提：B02, B03
要件：R27, R28。契約：K01, K11, K22
変更path：apps/ai-local/, packages/ai/src/
完了：本人用入口のHost/Origin/CSRF/ローカルペアリングと限定proxyを実装。偽CLIで先行試験でき、共有入口から実行できない。
検証：シェル注入、Origin/Host偽装、未認証、他人の旅程、API認証、壊れたJSON、timeout、利用枠超過を拒否。公開入口からCLIが起動しないこと。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## A03 生成ジョブの状態管理と重複防止
担当：M4。branch：feat/m4/a03。UI依存：none
前提：B02, B03
要件：R28。契約：K01, K02, K21
変更path：apps/ai-local/src/jobs/
完了：ローカルの生成ジョブ、Idempotency-Key、取消、再起動時の失敗を管理。実旅程候補の正本は共有DBへ保存する。
検証：CLIモックで二重送信、取消、再起動、別ユーザーのjobId、旧revisionを試験する。実Claudeの利用条件確認待ちでも単体実装を進める。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## A04 旅行計画の実生成と複数案
担当：M4。branch：feat/m4/a04。UI依存：none
前提：A03, S04, D03, D04, D06, A02, A01
要件：R01, R02, R03, R04, R13, R27。契約：K03, K05, K07
変更path：apps/server/src/trips/generation/
完了：本人のローカル画面からClaudeが旅程を作成し、実情報の検証を経て複数案を共有DBへ保存する。第三者要求を本人のPro枠へ中継しない。
検証：本人操作の実Claude＋実経路で生成を検証。モデル名、認証種別、取得元、待ち時間と結果を記録し、モックとは区別する。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## A05 代替候補と編集差分の再計算
担当：M4。branch：feat/m4/a05。UI依存：none
前提：A04
要件：R09, R10, R11。契約：K10
変更path：apps/server/src/trips/alternatives/
完了：地点変更や順序変更の影響区間を計算し、候補と費用差と不明点を返す。
検証：同一エリア変更でも時間が変化するケースと旧revisionの結果適用拒否。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## A06 旅行中の残り旅程再計画
担当：M4。branch：feat/m4/a06。UI依存：none
前提：A05
要件：R12。契約：K01, K10
変更path：apps/server/src/trips/replan/
完了：現在時刻、現在地、完了済み、固定予約を使って残りだけを再計画する。
検証：乗り遅れ、終電後、位置拒否、予約維持、更新競合を検証。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U03 条件入力の実画面
担当：M2。branch：feat/m2/u03。UI依存：approval
前提：U02, B02, D03
要件：R01, R02, R07, R13。契約：K01
変更path：apps/web/src/screens/conditions/
完了：入力補助と必須地点選択を実APIへ接続する。
検証：入力不足、現地日付、複数通貨、交通切替、必須地点の操作を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U04 地図と旅程の同期画面
担当：M2。branch：feat/m2/u04。UI依存：approval
前提：U02, S04, D03, D04
要件：R05, R06, R08。契約：K09, K06
変更path：apps/web/src/screens/itinerary/
完了：実データの地図、日別時刻、選択同期、未知運賃を表示する。
検証：スマートフォン操作と地図帰属、再読込時の保存内容を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U05 生成進捗と複数案の選択
担当：M2。branch：feat/m2/u05。UI依存：approval
前提：U03, U04, A04
要件：R04, R27, R28。契約：K02, K08
変更path：apps/web/src/screens/generate/
完了：状態照会と取消、複数案比較、採用を実装する。
検証：読み込み、失敗、取消、再試行、バックグラウンド時の停止と復帰。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U06 旅程編集と旅行中画面
担当：M2。branch：feat/m2/u06。UI依存：approval
前提：U04, A05, A06
要件：R09, R10, R11, R12。契約：K10, K21
変更path：apps/web/src/screens/edit/, apps/web/src/screens/travel/
完了：追加削除、候補変更、差分確認、旅行中の再計画を操作できる。
検証：タップ操作、キーボード、取消、版競合、GPS拒否を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U07 現在地とデジタルガイド
担当：M2。branch：feat/m2/u07。UI依存：approval
前提：U02, D07, D08
要件：R14, R15, R16, R23, R24。契約：K19
変更path：apps/web/src/screens/guide/
完了：番号地図、詳細パネル、出典、トイレ／避難情報が一画面でつながる。
検証：HTTPSの位置許可、拒否、圏外情報、近隣選択、権利表示を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## U08 SNSとグループの実画面
担当：M2。branch：feat/m2/u08。UI依存：approval
前提：U02, S05, S06
要件：R20, R21, R22。契約：K12, K13, K14, K16, K17
変更path：apps/web/src/screens/social/
完了：公開前確認、フィード、グループ、複製、旅程再編集が動く。
検証：2アカウントの公開と非公開を実ブラウザで確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## E01 写真付きしおりの印刷画面
担当：M2。branch：feat/m2/e01。UI依存：approval
前提：U04, U07, D07
要件：R17。契約：K18
変更path：apps/web/src/screens/print/, packages/exports/src/templates/
完了：予定表と許諾済み写真を印刷用に整え、地図画像の無断転載を避ける。
検証：改ページ、日本語、長い旅程、写真欠落、出典の読みやすさを確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## E02 認可付きPDF生成
担当：M1。branch：feat/m1/e02。UI依存：none
前提：E01, S02, S04
要件：R17, R30。契約：K18
変更path：apps/server/src/platform/exports/
完了：固定の印刷画面からPDFを生成し、要求者だけへ配信する。
検証：任意URL読み込み禁止、他人の旅程、timeout、並列制限、削除後再取得を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## E03 Maps連携と時差付きICS
担当：M3。branch：feat/m3/e03。UI依存：none
前提：D05, S04
要件：R18, R19。契約：K18
変更path：packages/exports/src/maps/, packages/exports/src/calendar/
完了：公式Maps URLとICSを生成し、自動アカウント登録との違いを明示する。
検証：日本と海外で日時を再読込。長いURLを分割し文字列を正しくエスケープ。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## O01 SNSと旅程共有だけをHTTPS公開
担当：M1。branch：feat/m1/o01。UI依存：none
前提：B03, S02
要件：R14, R30。契約：K22
変更path：scripts/serve-demo.mjs, docs/deployment.md
完了：共有Web/APIだけをHTTPSで公開する。ローカルAIのポート、生成処理、Claude認証、開発管理画面を公開しない。
検証：公開URLでSNSと保存を確認。公開URLに生成要求を送ってもCLI子プロセスが0回であることを確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## O02 サーバーデータのバックアップ復元
担当：M1。branch：feat/m1/o02。UI依存：none
前提：S01, S04, S05
要件：R25。契約：
変更path：scripts/backup.mjs, scripts/restore.mjs
完了：WALを考慮したバックアップと復元が動き、データを失わない。
検証：別の空DBへ復元して旅程、投稿、権限を比較。バックアップをGitから除外。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T01 契約とモックの自動試験
担当：M1。branch：feat/m1/t01。UI依存：none
前提：B02, B04, B05
要件：R01, R07, R28。契約：
変更path：tests/contracts/
完了：API、AI、UIサンプルの型と必須値を検証する。
検証：不正な日時、未知通貨、欠落データ、Schema破壊を検出。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T02 経路と旅程制約の試験
担当：M3。branch：feat/m3/t02。UI依存：none
前提：D04, D05, D06
要件：R03, R05, R06, R07, R11, R12, R13。契約：
変更path：tests/planner/
完了：日跨ぎ、時刻依存、固定予定、未知費用を回帰試験へ登録する。
検証：公式値と架空フィクスチャを区別し、外部データを無断保存しない。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T03 認証と共有権限の試験
担当：M1。branch：feat/m1/t03。UI依存：none
前提：S03, S04, S05, S06
要件：R20, R21, R22, R25, R26, R30。契約：
変更path：tests/access/
完了：private／group／publicをAPI直叩きでも保証する。
検証：権限なしの参照、編集、複製、PDF、退会後参照を拒否。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T04 AIとジョブ異常系の試験
担当：M4。branch：feat/m4/t04。UI依存：none
前提：A02, A03
要件：R27, R28, R30。契約：K03, K21
変更path：tests/ai/, tests/jobs/
完了：誤出力、重複、取消、上限、モデル停止をテストする。
検証：偽CLIで不正JSON、構造化出力なし、停止、上限、取消、キー混入、公開入口からの拒否を試験。実Claudeは明示許可した別試験。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## I01 最初の保存までの縦断統合
担当：M1。branch：feat/m1/i01。UI依存：none
前提：U01, S02, S04, T01
要件：R25, R26, R29。契約：
変更path：tests/e2e/smoke/
完了：ログイン→仮旅程表示→サーバー保存→再表示がつながる。
検証：この時点はAIと実経路の完成とみなさず、モック表示を残す。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## I02 本人の実Claudeと旅行データの生成統合
担当：M4。branch：feat/m4/i02。UI依存：none
前提：U05, A04, D03, D04, D02, T04
要件：R01, R02, R03, R04, R05, R06, R13, R27, R28。契約：K01, K07, K08
変更path：tests/e2e/generation/
完了：実モデルと取得済み実情報で旅程を生成し保存する。
検証：取得不可地域は成功と偽らず、動作した代表ケースと警告を記録。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## I03 編集と乗り遅れの統合
担当：M4。branch：feat/m4/i03。UI依存：none
前提：U06, A06, T02
要件：R09, R10, R11, R12。契約：
変更path：tests/e2e/replan/
完了：旅行前編集と旅行中の残り再計画が画面と保存に反映される。
検証：固定予約保持、完了済み保持、競合保存拒否を実操作。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## I04 2ユーザー間のSNS統合
担当：M1。branch：feat/m1/i04。UI依存：none
前提：U08, T03, O02
要件：R20, R21, R22, R25, R26。契約：K13, K14, K16
変更path：tests/e2e/social/
完了：別アカウントと別ブラウザで共有、コピー、非公開、復元を確認する。
検証：同じ端末の別タブだけでなく独立したcookie領域で確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## I05 現地ガイドと出力の統合
担当：M2。branch：feat/m2/i05。UI依存：none
前提：U07, E02, E03
要件：R14, R15, R16, R17, R18, R19, R23, R24。契約：
変更path：tests/e2e/guide-export/
完了：番号地図、解説、施設、PDF、ICS、Maps連携を一通り確認する。
検証：未取得データ、拒否GPS、画像権利、タイムゾーンを確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T05 公開境界と費用の安全試験
担当：M1。branch：feat/m1/t05。UI依存：none
前提：O01, T03, T04, D02
要件：R30。契約：
変更path：tests/security/
完了：SNSの権限、外部APIの利用上限、公開サーバーと本人用AI入口の分離、秘密情報非公開を確認する。
検証：外部から生成できないこと、SSRF/CSRF/Origin/Host偽装、他人の非公開データ、ログ漏えい、無断課金を確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T06 国内外と交通手段の実接続試験
担当：M3。branch：feat/m3/t06。UI依存：none
前提：I02, I03, D08
要件：R05, R06, R07, R23, R24。契約：
変更path：tests/live/, docs/provider-probe.md
完了：対応範囲と未取得項目を実接続の証拠として保存する。
検証：国内公共交通／国内車／海外公共交通／海外車のケースを区別。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## T07 ユーザー提供ケースの受入確認
担当：M2。branch：feat/m2/t07。UI依存：approval
前提：I02, I03, I04, I05, T05, T06
要件：R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30。契約：
変更path：docs/acceptance/
完了：ユーザーの実旅行シナリオを確認し、全要件に合否と証拠を付ける。
検証：過去日付は現在APIの制約を考慮。未実施やモックだけを合格にしない。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## Z01 設計と実装とタスクの整合確認
担当：M1。branch：feat/m1/z01。UI依存：none
前提：T07, G02, O02
要件：。契約：
変更path：docs/, ops/tasks.json, README.md
完了：図の全node/edge、HTTP入出力、実装paths、Issue/PR/証拠、HTMLとAI仕様の一致を確認。未実装を隠さない。
検証：DAGの循環なし、要件の担当漏れなし、閉じたIssueに証拠あり。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。

## Z02 クリーンクローンと発表用の最終確認
担当：M1。branch：feat/m1/z02。UI依存：none
前提：Z01
要件：。契約：
変更path：docs/demo-runbook.md, docs/release-report.md
完了：既存tkb_2627の同一Git履歴を新環境で取得して起動でき、発表操作と再起動手順を決める。
検証：全要件の達成状況を正直に報告。公開URL停止とDBバックアップを確認。
引継ぎ：Issueにcommit、PR、変更path、実行テスト、fixture/live、残る疑問、次担当への依頼を1コメントで記録。
