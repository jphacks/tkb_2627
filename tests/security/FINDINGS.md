# T05 FINDINGS: 公開境界と費用の安全試験 (R30)

試験: `tests/security/*.test.ts`。通常試験は外部通信なし(loopback の実ソケットのみ)。実Claude CLI・課金APIは不使用。

## 不具合
今回の試験範囲で実装の不具合は見つからなかった(it.skip なし)。以下は不具合ではない観測。

| # | 観測 | 影響 | 扱い |
|---|---|---|---|
| O-1 | `app.inject()`(light-my-request)は `/\local\v1\pair` を WHATWG URL 経由で `//local/...` と解釈し、SPA シェルを返す | inject 固有。実サーバーでは static.ts が `\` を `/` に正規化して予約 prefix と判定し 404、SPA も返らない | `public-boundary.test.ts` の「raw request targets」(実ソケット、GET は status>=400 も確認)で検証済み |
| O-2 | `apps/ai-local/src/main.ts` は単回使用ペアリングコードを端末へ `console.log` する | 設計どおり(A02)。端末のみ・HTTP非公開 | 変更不要。ソース走査は補間された秘密を禁止する範囲に限定 |
| O-3 | CI は `check:secrets` というスクリプト名を含むが secrets 参照ではない | なし | 試験の正規表現は `${{ secrets` / `secrets.` / GITHUB_TOKEN のみ対象 |

## PDF出力(E02/K18)を追加: `exports.test.ts` (37件、実レンダラー、外部通信なし)
不具合なし。担保した観点:
- 本文は strict: url/html/template/出力先/footer 等の追加項目、format の URL/html/docx/配列/オブジェクト、ics/maps、別 tripId、配列/null/文字列は 422(VALIDATION_FAILED)で、枠を消費しない。非JSONの content-type は 4xx。パスの trip id の traversal/URL は 404 で反響なし。
- CSRF 無し・他人のCSRF・偽トークンは POST/DELETE とも 403。https PUBLIC_ORIGIN での Origin/Host/X-Forwarded-Host 偽装は他の書込みと同様 403。
- 応答: PDF は application/pdf、`attachment; filename="安全な固定名"`、no-store、nosniff。エラー・401・202・204 も no-store。ファイル名にタイトルや改行/パス片が入らない。
- PDF 本体(生バイトと全 Flate ストリーム、ToUnicode の code point)に privateNotes・自宅名・出発地ラベル・mayExport=false の文言がない。タイトルの code point は見える(陽性対照)。URL・/URI・/JavaScript・/Launch・/OpenAction・/EmbeddedFile も無い。
- 上限: 同一ユーザーの並列20件で 202 は1件、残りは 429 RATE_LIMITED。複数セッション・複数旅程でも1枠。ユーザー横断の並列で QUEUE_FULL が効く。描画失敗/タイムアウトで枠が戻り、内部パス・例外文言が出ない。
- /local: 共有 app に /local・generations の経路がなく、exports ソースは child_process/@tkb/ai/ネットワーククライアント/process.env を使わない。
- 注意: 「削除して再作成を繰り返す」試験は、削除後に枠が空き再投入できる現行仕様(同時実行は1のまま)を固定しており、短時間に何度でも描画を始められる点は上限ではない(観測。不具合とは扱わない)。

## D02 後に追加(未統合のため未試験)
D02(M3、外部APIの呼出し上限・課金回数制限)は main 未統合。次を D02 統合後に追加する。
- 外部API(地図/運行情報等)の呼出し回数上限と、上限超過時に追加課金が発生せず固定の失敗(例 RATE_LIMITED/UNAVAILABLE)になること。
- 未認証・他人・同時並列の要求が上限カウンタを迂回しないこと、再起動やリトライでカウンタが巻き戻らないこと。
- キー(GOOGLE_MAPS_SERVER_KEY 等)がレスポンス・ログ・ブラウザバンドルに出ないこと(今回はキー名の走査と空値のみ確認)。
- `PROVIDER_MODE=live|mixed` を許可する場合、既定で拒否のままで明示 opt-in が必要なこと(現状は loadConfig が拒否する試験のみ)。

## 観点と担保箇所

凡例: 新規 = T05 で追加、既存 = 既存試験で担保済み(重複させない)、D02待ち。

| 観点 | 担保 | どこで |
|---|---|---|
| 共有 app のルート表に generation/jobs/local/pair が0件 | 既存(基本)+新規(静的配信ON、printRoutes全体) | apps/server/test/exposure.test.ts; public-boundary.test.ts |
| `/local`・`/api/v1/generations` の大小文字・%エンコード・`//`・末尾/・`/..`・全メソッド(HEAD/OPTIONS含む)で到達不能、SPAも返さない | 新規 | public-boundary.test.ts |
| 実ソケットでの生ターゲット(`\`、`//`、絶対形式、%5c、%2e%2e) | 新規 | public-boundary.test.ts |
| 同一プロセスに共有/本人用 app を同居しても互いのルートを持たない、共有Cookieは本人用で無効 | 新規 | public-boundary.test.ts |
| 共有入口の生成・job・cancel・pair が404、capabilities=SHARED_ENTRY_NO_PERSONAL_CLAUDE | 既存 | tests/ai/entry-boundary.test.ts |
| 本人用 app の非loopback Host拒否、forwardedヘッダ偽装、Origin、CORS無し、bind検証 | 既存 | tests/ai/entry-boundary.test.ts, apps/ai-local/test/local-gate.test.ts |
| 本人用ペアリング/CSRF/所有者限定/ログイン中継の固定パス | 既存 | apps/ai-local/test/local-gate.test.ts |
| キー混入(request body、constraints、GenerationInput) | 既存 | tests/ai/entry-boundary.test.ts |
| 共有サーバーが child_process/@tkb/ai/ALLOW_CLAUDE_EXECUTION を持たない・実行時に spawn しない | 既存 | apps/server/test/exposure.test.ts |
| SSRF: ソース全体の外向き通信が shared-client の fetch 1箇所のみ(http/net/undici/ws/dns 不使用) | 新規 | public-boundary.test.ts |
| SSRF: ユーザー指定の URL/Host/Referer/X-Forwarded-*/クエリ/追加body項目が上流URLに影響しない(常に SHARED_BASE_URL+固定パス、ヘッダは content-type のみ、body は loginId/password のみ) | 新規 | public-boundary.test.ts |
| SSRF: 上流の 3xx に追従しない(redirect: manual)、shared-client は login 以外のメソッドを持たない | 新規 | public-boundary.test.ts |
| SSRF: 共有サーバーに URL を受ける/redirect する経路が無い | 新規(ソース走査) | public-boundary.test.ts |
| Host偽装: TRUST_PROXY=loopback で XFF 左端の偽装ローテーションでも IP 制限(50回)を回避できない(右端採用)。非 loopback ピアの XFF は無視。未設定時は XFF/X-Real-IP/Forwarded 無視 | 新規 | public-boundary.test.ts |
| TRUST_PROXY は loopback 以外(true/1/CIDR)を拒否 | 新規(config) | public-boundary.test.ts |
| https PUBLIC_ORIGIN で Origin/Host/X-Forwarded-Host 偽装・`null`・dev origin の書込みが403 | 新規(既存は cross-origin と dev origin の個別確認) | public-boundary.test.ts; apps/server/test/auth.test.ts |
| 共有ログインの CSRF/Origin 基本、レート制限、同一応答、forged cookie | 既存 | apps/server/test/auth.test.ts |
| 無断課金: apps/packages/scripts に ANTHROPIC_*/OAuth/API URL/SDK への言及が probe のみ。probe は子環境から課金変数を除去し spawn は filtered env・shell:false | 新規 | spend-and-secrets.test.ts |
| 無断課金: package.json/lockfile にLLM SDK依存なし、他モジュールは process.env を子へ継承しない | 新規 | spend-and-secrets.test.ts |
| 無断課金: CI workflow が secrets/GITHUB_TOKEN/pull_request_target を使わず、Claude CLIを起動せず、ALLOW_CLAUDE_EXECUTION:'false'・contents:read | 新規 | spend-and-secrets.test.ts |
| 無断課金: ALLOW_CLAUDE_EXECUTION 既定false(`TRUE`/`1`/`yes`も false)、PROVIDER_MODE live/mixed を拒否、vitest が fixture/false を固定 | 新規 | spend-and-secrets.test.ts |
| 無断課金: 共有 config が課金/実行 env を読まない、capabilities は none、本人用は available=false(allow=true でも)、main は実runner未接続 | 新規(本人用 capabilities は既存と重複する範囲を最小化) | spend-and-secrets.test.ts; tests/ai/entry-boundary.test.ts |
| 外部API呼出し上限・課金回数制限 | D02待ち | 上記「D02後に追加」 |
| ログ漏えい: 両 app の logger 無効(ソース固定)、console 呼出しは固定文のみ | 新規 | leakage.test.ts |
| ログ漏えい: 共有・本人用でログイン失敗/CSRF/Origin/429/malformed/成功/500 の間、console と stdout/stderr への出力が空 | 新規 | leakage.test.ts |
| 500応答: 例外メッセージ・stack・絶対パス・SQLite 文言・password/token/cookie値が応答本文・ヘッダに出ない(同期/非同期/非Error throw/5xx statusCode/DBエラー/DBクローズ後) | 新規 | leakage.test.ts |
| 本人用: 上流例外・上流5xx本文・不正JSON・非ownerの応答に上流cookie/csrf/内部情報が出ない。ペアリング/CSRF失敗でコード・セッション値・csrfが出ない | 新規 | leakage.test.ts; 既存 tests/ai/entry-boundary.test.ts (job応答のupstream cookie) |
| 応答ヘッダ: server/x-powered-by/via なし、x-request-id はサーバー採番(クライアント値を反映しない) | 新規 | leakage.test.ts |
| 秘密情報: env テンプレートの KEY/SECRET/TOKEN/PASSWORD が空、安全な既定、bind=127.0.0.1、web が秘密 env を読まない、.gitignore | 新規(スキャナ自体は既存) | spend-and-secrets.test.ts; tests/contracts/secret-scan.test.mjs |
| Cookie 属性: http は HttpOnly/SameSite=Lax/Path=/ /Max-Age/Domainなし。https は __Host-/Secure/HttpOnly/SameSite/Domainなし、logout が同属性で失効、HSTS。本人用は HttpOnly/SameSite=Strict/Path=/local | 新規(既存は主要属性の存在確認) | leakage.test.ts; apps/server/test/auth.test.ts |
| 他人の非公開データ(trips/posts/copy/groups、snapshot、removed member) | 既存 | tests/access/matrix.test.ts |
| AI/job 異常系(重複・timeout・不正出力・復旧) | 既存 | tests/jobs/jobs-abnormal.test.ts, tests/ai/*.test.ts |
| 静的配信の traversal/symlink/ソースマップ/予約prefix | 既存 | apps/server/test/static.test.ts |
| `/api` 未ガードルートの登録拒否 | 既存(本試験は500試験用ルートをガード付きで登録) | apps/server/test/auth.test.ts |

## 注意(試験設計)
- 500 を起こす試験用ルートは各 test 内で一時登録した(実装コード変更なし)。共有側は未ガードルートの登録拒否に合わせ `app.authenticate` を付与。
- CORS/実ネットワークの cloudflared 経由確認は対象外(人間が docs/deployment.md の手順で実施)。
