# T07 受入確認記録（全30要件）

- 対象: Issue #53「ユーザー提供ケースの受入確認」。基準は `origin/main` の `982b3cf`（#169 まで）。初版は `c32ce76`（#148 まで）で、その後の #152〜#168 の証拠で下記の行を更新した（判定の件数は変わらない）
- 作成: 2026-10-25（同日、#152〜#168 を反映して更新）。この文書は repo 内の記録だけを根拠にした**机上の突合せ**で、新しい実行はしていない（外部 API・Claude は呼んでいない）
- 要件の文言は `ops/requirements.json` の `acceptance`。仕様は `docs/01_SPEC.md`
- 判定の規則
  - **合格**: 実物の処理（実サーバー・実ロジック・docs に記録された live 実接続）で、受入条件の主要部分を確認済み
  - **一部合格**: 一部は上の意味で確認済みだが、受入条件に未確認の部分が残る
  - **fixtureのみ**: fixture・モック・fake runner・架空データだけで確認。合格にしない
  - **人間のUI承認待ち**: 画面が主体の要件。人間の承認記録が `docs/ui/reviews/` にない（`gh` が使えず Issue コメントは未確認）。裏の処理の試験結果は証拠欄に分けて書く
  - **未実施**: 該当の確認をした記録がない
  - **対象外**: なし
- live 実接続は `docs/provider-probe.md`・`docs/claude-connection-check.md`・`tests/e2e/generation/README.md` に記録があるものだけを数える

## 判定の集計

| 判定 | 件数 | 要件 |
|---|---|---|
| 合格 | 4 | R06, R07, R21, R26 |
| 一部合格 | 11 | R02, R03, R05, R18, R19, R20, R22, R25, R27, R29, R30 |
| fixtureのみ | 8 | R04, R10, R12, R13, R15, R17, R23, R24 |
| 人間のUI承認待ち | 7 | R01, R08, R09, R11, R14, R16, R28 |
| 未実施 | 0 | — |
| 対象外 | 0 | — |
| 計 | 30 | |

承認の記録がある UI 画面は 0 件。`docs/ui/reviews/2026-10-24_U01_review.md` は U01 への指摘 7 件（要修正5、保留2）で、「承認に当たる指摘はない」と明記されている。U03〜U08 の画面はレビュー記録がない。

## 要件ごとの判定

試験の場所の略記: e2e = `tests/e2e/`、live = `tests/live/`。PR 番号は `git log --oneline` による。

| 要件 | 判定 | 証拠 | 残る制約 |
|---|---|---|---|
| R01 旅行条件の入力（地域・日程・交通・予算・必須地点、不足の明示） | 人間のUI承認待ち | 画面 U03（#127、モック／live 両モード）。契約 K01 の検証は `tests/contracts/values.test.ts`、`apps/web/src/screens/conditions/` の試験。生成入力は e2e/generation（#136） | 人間の画面承認なし。画面から live 生成までの通し操作の記録なし |
| R02 観光地と寄り道の推薦（実在候補・写真/出典付き・選択） | 一部合格 | live: Places Text/Nearby の名前・住所・座標・件数を確認（`docs/provider-probe.md` D01 の7回、D03 adapter 2回、T06 #143）。adapter は #98 | 営業時間・写真・説明は K05 の live 検索で返らない（T06 で4件とも null）。写真は D07（#144）の試験は fixture。選択操作の画面は承認待ち。Places の内容は保存・AI入力・転載不可が既定（`mayStore=false` 等） |
| R03 訪問順序と経路の調整（検証・不成立を隠さない） | 一部合格 | 決定的な検証ロジック D06（#77）と試験 `tests/planner/schedule.test.ts`・`routes.test.ts`（#135）。近い予定の親子まとめと食事直後の食べ物の警告 `meal_after_meal`（D06 #161、`packages/planner/src/schedule/grouping.test.ts`）、生成での同じまとめ（A04 #164、`apps/ai-local/test/a04-grouping.test.ts`）、親子の入れ子の検証（K07、`apps/server/test/trips-nesting.test.ts`）。生成 e2e で取得不可地域は成功を装わず failed（#136、稚内の live 実行も同じ） | 営業時間の live 取得が入った状態の検証なし。親子まとめ・`meal_after_meal` は fixture の旅程での確認で、live の生成結果では未確認。国内公共交通は所要時間不明のまま時刻未定 |
| R04 複数旅程の比較（両立しない希望で残す地点・除外理由が異なる案） | fixtureのみ | `apps/ai-local/test/a04-compare-r04.test.ts`（実 assemble・planner・D06。手書き blueprint 3案で、残す地点が3案とも異なり、案ごとに除外理由が別: 日程に収まらない／営業時間外、必須地点を落とした案は invalid、移動不明は時刻なしで不明のまま）。比較画面は除外地点ごとにその案の理由を表示（`render.test.tsx`）。A04 の live 実行で候補3件（場所は fixture）も確認（`tests/e2e/generation/README.md`） | blueprint は手書きで、実 Claude が両立しない希望から案を作った記録はない。比較画面の人間UI承認なし。理由は warnings の文として保存され、型付き理由コードは契約にない（`excludedPlaceIds` は ID のみ）。実データの営業時間は未確認 |
| R05 公共交通の詳細（路線・乗降・時刻・乗換・運賃/ホーム、不明は未取得） | 一部合格 | live: パリは路線名・運賃・乗換回数・乗降駅が返る（D01、D04 adapter、T06 #143）。ホームは返らず null。国内は金沢駅→兼六園・金沢駅→東京駅とも経路0件（D01、#89）で `unsupported_region` として返す（#92、#113） | **国内の公共交通は取得不可**。国内は別 provider の判断が未決。確認した海外は1都市（パリ）、1区間ずつ。運賃は常に返るとは限らない |
| R06 自動車の経路（別モード・区間経路と所要時間・旅程へ反映） | 合格 | live: 金沢・パリとも所要時間と距離を取得（D01、T06 #143 の国内車・海外車）。旅程への反映は A04 の mixed 実行で live Routes 6回（`docs/claude-connection-check.md`、#108） | 車の運賃・駅名は対象外。Routes の詳細区間は保存せず表示時に再取得（D-1）。画面表示は承認待ち |
| R07 国内外の日時と通貨（IANA、日跨ぎ、夏時間、複数通貨、不明費用） | 合格 | 日時・通貨の計算 D05（#74）、`tests/planner/time.test.ts`・`money.test.ts`。ICS で夏時間終了日のパリの重複時刻を UTC で出力（e2e/guide-export、#148） | 外部データには依存しない検証。実際の運賃データを使った通貨換算は未確認（不明費用は 0 にせず null） |
| R08 地図と行程表の同期 | 人間のUI承認待ち | 画面 U04（#125）を作り直し（#155。n×2 の表、入れ子の予定 `parentActivityId`、矢印、ドラッグ並べ替え、U03 下のプレビュー）。試験 `apps/web/src/screens/itinerary/table.test.tsx`・`itinerary.test.tsx`。レビュー指摘 R5（地図の点と同期）が U04 に割当（`docs/ui/reviews/2026-10-24_U01_review.md`） | 作り直し後の U04 も人間の承認なし。実際の地図は未表示（地図の表示は課金とキーの承認後と記録）。Places の結果は Google 地図上にしか表示できない（`docs/provider-probe.md`）。承認なし |
| R09 旅程の追加削除と並べ替え（保存・版競合で上書きしない） | 人間のUI承認待ち | 裏側: 実サーバーで古い revision の適用が 409 `REVISION_CONFLICT` で旅程不変（e2e/replan、#137）。画面 U06（#132）。U06 は共通の旅程表とドラッグ並べ替えに変更（#159、`apps/web/src/screens/edit/edit.test.tsx`） | ドラッグ並べ替えを含む画面の承認なし（試験はテスト環境の操作）。差分確認の画面操作の記録なし |
| R10 近隣の代替候補（変更後の経路と営業時間を再検証） | fixtureのみ | A05（#114）、プレビュー→PATCH→取得（e2e/replan、#137）。契約 #117 | 候補の地点は fixture。営業時間の再検証は live 営業時間がないため実データで未確認 |
| R11 予算と所要時間の更新（時間差・既知費用差、不明費用を 0 にしない） | 人間のUI承認待ち | diff は `@tkb/planner` の1定義（#76）、`tests/planner/money.test.ts`、再計画 e2e で同じ diff（#137）。印刷モデルで不明は未定/不明（#148） | 表示画面の承認なし。費用は実データがなく、live 実行でも既知費用 0/5（`tests/e2e/generation/README.md`） |
| R12 旅行中の再計画（訪問済み・固定予定を保持） | fixtureのみ | A06（#118、#139）。実サーバーの再計画 e2e（固定予約不変、完了済み保持、missed の競合報告、座標を保存しない。#137） | 実際の遅延・現在地での実機操作なし。使用データは fixture。A06 の live 確認は docs に詳細の記録がなく（`docs/provider-probe.md` に言及のみ）数えない |
| R13 食事と自由散策（固定店舗と食べ歩きを別の予定に） | fixtureのみ | 契約 `ActivityKind`（`meal` と `free_walk`、`packages/contracts/src/trip.ts`）、`packages/planner/src/schedule/validate.test.ts`、印刷モデルの種別表示（#148）。D06 の `meal_after_meal`（#161）と A04 の親子まとめ（#164）の試験を追加 | 生成 AI が両者を作り分けた live の記録なし。編集画面の承認なし。飲食店の Nearby live は D03 で5件取得のみ |
| R14 現在地連動の観光ガイド（GPS 許可・番号付きスポット・拒否時の手入力） | 人間のUI承認待ち | 画面 U07（#145）。ガイド取得 `GET /api/v1/guides` を画面に接続（K19、#152、`apps/server/test/guides.test.ts`、`apps/web/src/screens/guide/guide.test.tsx`）。裏側: 番号順、位置なしは別掲、GPS 拒否時の代替エリアで結果を返す（e2e/guide-export、#148） | 実機の GPS 許可・拒否の操作記録なし。承認なし |
| R15 写真と歴史解説（画像・説明・出典・権利、未取得の区別） | fixtureのみ | D07（#144）、権利のない写真は出力に出さない（e2e/guide-export の scenario 4、#148）。`GET /api/v1/guides` が説明と許諾済み写真を返す（#152）が、試験は fixture。「解説なし」を生成しない | docs に実データの記録がない。`packages/travel-data/probes/results/2026-10-25-d07-wikipedia-live.json` は存在するが docs に要約がなく数えない。Google の写真は保存・転載不可 |
| R16 デジタルパンフレット（エリア地図→詳細→戻る、モバイル） | 人間のUI承認待ち | ガイド画面 U07（#145） | 実機表示と承認の記録なし |
| R17 PDFの旅行しおり（文字と許諾済み写真） | fixtureのみ | E02（#128）、`tests/security/exports.test.ts`・`tests/access/exports.test.ts`（#138）、実サーバーで `application/pdf` と `%PDF` を確認、他ユーザーは 404（e2e/guide-export、#148）。印刷画面 E01（#142） | 旅程は fixture。許諾済み写真は credit 行のみ。実在の写真入り PDF を人が読んだ確認なし。Google 由来の内容は `mayExport=false` で除外 |
| R18 Googleマップ連携（公式URL、自動登録と区別） | 一部合格 | E03（#78、#85）。URL 生成は未知地点を報告、`mayExport=false` と自宅を除外（e2e/guide-export、#148）。所有者だけの Maps リンク route と印刷画面のボタン（#163、`apps/server/test/exports-ics-maps.test.ts`、`apps/web/src/screens/print/calendar-maps.test.tsx`） | URL を実際の Google マップで開いた確認の記録なし。保存済みリストへの自動登録は未提供（偽装しない方針）。解釈は `docs/10_OPEN_ITEMS.md` で要確認 |
| R19 時差を保持した予定出力（ICS） | 一部合格 | E03（#78）。TZID／UTC を項目ごとに出力、夏時間の重複時刻は UTC、未定・転載不可は除外（e2e/guide-export、#148）。所有者だけの ICS route と印刷画面のボタン（#163、`apps/server/test/exports-ics-maps.test.ts`、`apps/web/src/screens/print/calendar-maps.test.tsx`） | 実際のカレンダーアプリで別タイムゾーンから取り込んだ確認の記録なし。アカウントへの自動登録は未確認 |
| R20 SNSへの旅行記録と旅程投稿（別ユーザーのブラウザで閲覧） | 一部合格 | 実サーバーで2ユーザー（別 cookie jar）。公開/非公開の投稿、公開投稿だけが B と匿名に見える、取り下げ・削除、古い revision は 409（e2e/social、#134）。S05（#65）、U08（#129） | 「ブラウザ」はテスト内の cookie jar。実際の2台のブラウザでの操作と画面承認の記録なし |
| R21 公開範囲とグループ共有（権限のない人は直接 URL でも不可） | 合格 | アクセス行列 `tests/access/matrix.test.ts`（#70）。非公開投稿は B に 404（存在しない ID と同じ）、グループ投稿は退会後 404（e2e/social、#134）。S03（#61） | 画面上のグループ操作は承認待ちだが、受入条件の判定（サーバー側）は実サーバーで確認済み |
| R22 他人の旅程の複製と再利用（日付変更後の再検証） | 一部合格 | 公開投稿を複製すると 201、所有者は B、非公開データなし、`needs_revalidation`（e2e/social、#134）。S06（#66） | 日付を変えた後に時間と交通を実際に再検証した記録なし（フラグのみ確認） |
| R23 周辺トイレ情報（取得不可を空集合と混同しない） | fixtureのみ | D08（#133）、K19、金沢近辺でトイレ・避難場所・避難所が別種、「【架空】」表示、パリは `unsupported_region`（e2e/guide-export、#148） | 実データの provider なし。fixture が架空であることを画面に出す設計。実在の公的データでの確認なし |
| R24 避難場所と避難所情報（公的情報・出典・取得日、開設状況を断定しない） | fixtureのみ | R23 と同じ。避難所の警告表示と `openNow` が null（#148） | 公的データの取得は未実施。取得日・出典は fixture 値 |
| R25 共通サーバーの永続保存（再起動・別端末・バックアップ復元） | 一部合格 | 実サーバープロセスの再起動後に同じ旅程（e2e/smoke、#103）。バックアップと復元後に投稿・公開範囲・複製・ACL が維持（e2e/social の scenario 5、#134）。O02（#69）、`docs/backup.md`。Z02 の clean clone で `db:backup`（integrity_check 通過、権限 0600、サーバー稼働中）と `db:restore`（行数一致、復元 DB で trips 1件）を実行（`docs/release-report.md`、#168） | Z02 の確認は同じ PC 上の review DB（fixture）で、別端末・別ブラウザの確認の記録なし。公開サーバー上での復元の記録なし。デモ公開を `docs/deployment.md` の手順で実施した記録が docs にない |
| R26 複数ユーザーの認証と所有権 | 合格 | 他ユーザーは旅程に 404・一覧に出ない、再ログインで同じ旅程（e2e/smoke、#103）。`tests/access/matrix.test.ts`（#70）。S02（#58） | 招待制ユーザー作成は M1 の運用。別端末は新規ログインで代替して確認 |
| R27 Claude による旅程の自動生成（本人の公式 Claude Code、検証して保存） | 一部合格 | live: M4 の PC で CLI `2.1.301`、`authMethod=claude.ai`、構造化出力1回が schema に一致（`docs/claude-connection-check.md`、#59）。A04 の mixed 実行（Claude live＋Routes live、場所は fixture、#108）。I02 の live 実行で金沢は succeeded・稚内は保存せず failed（`tests/e2e/generation/README.md`、#136）。パイプライン #106 | 実機は M4 の PC 1台のみ。M1（macOS）・他メンバーは未確認。利用条件は「チームの解釈」で Anthropic の回答ではなく、M4 と M1 の Issue #25 への同意コメントは確認できない。共有 URL からの利用は不可（設計どおり）。場所が実データ（live Places）の生成は、保存・AI入力の制約のため成功を装わず `needs_review` |
| R28 生成処理の待ち状態と失敗対応（進捗・取消・タイムアウト・上限・再試行・重複防止） | 人間のUI承認待ち | 裏側: A03（#64）。Idempotency-Key で同じジョブを返し二重実行・二重保存なし、不正なモデル出力は failed で保存なし（e2e/generation、#136）。`tests/jobs/jobs-abnormal.test.ts`、`tests/ai/*`（#71）。画面 U05（#141） | 実 Claude でのタイムアウト・利用枠超過・未ログインの実機の値は未確認（`docs/claude-connection-check.md`）。進捗・取消の画面承認なし。試験は fake runner |
| R29 スマートフォンUIの反復改善（実機相当・レビュー記録・並行実装） | 一部合格 | U01（#82）、人間レビューの記録（`docs/ui/reviews/2026-10-24_U01_review.md`、#95）。U03〜U08 の実装が続いた（#125〜#147）。レビュー指摘で U04・U06 を作り直し（#155、#159）、画面確認を `npm run review` 1コマンドに（#154、`tests/review.test.mjs`）、画面ごとのタスク/Issue バッジ（#153） | レビューは U01 の1回のみ、承認なし。U02 以降の画面のレビュー記録なし（作り直し後の再レビューも記録なし）。実機（実スマートフォン）での確認の記録なし |
| R30 公開時の安全と利用上限（秘密・非公開・AI管理ポート、API 上限、許諾データ） | 一部合格 | B05（#57）、`tests/contracts/secret-scan.test.mjs`、`tests/security/public-boundary.test.ts`・`spend-and-secrets.test.ts`・`leakage.test.ts`（#73）。O01（#62）、D02 の呼出し上限（#88、#91、#120）。live 呼出しは上限内で記録（D01 系12回＋T06 の7回、`docs/provider-probe.md`） | 実際の外部公開（Cloudflare Tunnel 経由）での確認の記録なし。Google の保存・AI入力・転載の規約（Service Specific Terms）は未確認で保守的な既定のまま。Routes の GCP 側 quota は無制限でコード側上限のみ |

## ユーザー提供ケース

- `ops/collaboration-cases.json` は、**旅行ケースではなく、チーム運用の手順3件**（新データ項目の依頼、利用枠切れ・離席、Agent の分け方）。ユーザーの実旅行シナリオではない
- `docs/` と `tests/` にも、ユーザー（人間）が提供した実旅行のシナリオを記録した文書は見つからなかった。**ユーザー提供ケースの受入確認は未実施**
- repo にある旅行ケースはすべて開発側が作ったもの。実際に走らせた範囲は次のとおり

| ケース | 種別 | 対応する要件 | 実行内容と記録 |
|---|---|---|---|
| 金沢（国内・車・live 経路＋fixture 場所、1日） | 開発側の live | R06, R27, R28 | A04 の mixed 実行（Routes 6回、#108）。I02 live 実行（`tests/e2e/generation/README.md`） |
| 金沢（国内・公共交通） | 開発側の live | R05, R27 | 経路は取得不可で所要時間不明・時刻未定。成功を装わない（I02、T06 #143） |
| パリ（海外・公共交通/車） | 開発側の live（経路のみ） | R05, R06, R07 | T06 の4ケース（Google 呼出し7回）、D01、D04 adapter |
| 稚内（取得不可地域） | 開発側の live | R03, R27 | `CONSTRAINT_UNSATISFIED` で failed、モデル未呼出し、保存なし |
| 金沢の編集・再計画（固定予約、完了済み保持、競合） | fixture | R09〜R12 | e2e/replan（#137） |
| 2ユーザーの公開・非公開・グループ・複製・復元 | 実サーバー（fixture データ） | R20〜R22, R25, R26 | e2e/social（#134） |
| ガイド・PDF・ICS・Maps・写真権利 | 実サーバー（fixture データ） | R14〜R19, R23, R24 | e2e/guide-export（#148） |

### 人間が用意・実施する必要があること
1. 実際の旅行シナリオ（行き先・日付・交通手段・予算・必須地点・出発/帰着・固定予定・避けたい点）を1〜3件、Issue #53 に提供する。国内の車、海外の公共交通を各1件含めると R05/R06 の区別に使える
2. **過去日付の旅行**を含める場合の扱いを決める。Routes の TRANSIT の出発時刻は7日前から100日後まで（`docs/provider-probe.md`）。過去の旅行は実時刻の経路取得ができないため、旅行前・旅行中の再計画の確認は未来の日付に置き換えるか、取得不可として扱う
3. 提供されたケースを、M4 の PC（本人の Claude 接続）で `PROVIDER_MODE=mixed`、`AI_MAX_LIVE_LEGS` 6以下で生成する。Google の追加呼出しは M1 の承認が必要（D01 の承認済み20回のうち12回使用。残り回数は M1 が確認）
4. 画面 U03〜U08 を実機のスマートフォンで操作し、各画面の承認または要修正を Issue に人間のコメントとして残し、`docs/ui/reviews/` に記録する
5. 実際のカレンダーアプリへの ICS 取り込み、Google マップで URL を開く、PDF を開く確認をし、結果を記録する
6. デモ前に、公開サーバー（Tunnel）経由で2台のブラウザから R20〜R22 を操作し、バックアップ復元を1回行う

## デモの主なリスク

1. **国内の公共交通が取得できない**（R05）。金沢で公共交通を選ぶと時刻未定になる。デモは国内なら車、公共交通ならパリで見せる。別 provider の判断が必要
2. **UI の人間承認がない**（R01, R08, R09, R11, R14, R16, R28）。U01 以降、承認記録は 0 件（U04・U06 は作り直し済みだが再レビューなし。`npm run review` で確認できる状態）で、地図は実物が表示されていない（課金とキーの承認待ち）
3. **生成は M4 の PC 1台に依存**（R27）。M1 の macOS・他メンバーは未確認で、共有 URL の利用者は生成できない（設計どおり）。利用条件の同意コメントと、利用枠超過・未ログイン時の実挙動も未確認
4. **場所の実データを使う生成が制限される**（R02, R03, R15）。Google の場所は保存・AI入力・転載不可が既定で、live 検索では営業時間・写真・説明が返らない。デモの場所は fixture
5. **トイレ・避難所・写真・PDF・ICS は fixture のみ**（R15, R17, R23, R24）。実在の公的データで確認しておらず、「架空」表示を前提にする。別端末・公開サーバー上の復元・実カレンダー取り込みも未確認（バックアップ復元は Z02 でローカルの clean clone のみ確認）
