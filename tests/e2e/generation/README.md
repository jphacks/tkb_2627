# I02 generation end to end

## CI test (no real Claude, no network)

    npx vitest run tests/e2e/generation

`generation.test.ts` runs the real shared server (in-memory DB, `PROVIDER_MODE=fixture`) and the real personal app in process, with a fake model.
Cases: (a) 金沢 K01 -> job succeeded -> K07 saved -> K08 read back, fixture labels, warnings, null for unknown values, other user gets 404;
(b) an area without data fails with `CONSTRAINT_UNSATISFIED` before any model run and saves nothing; (c) same Idempotency-Key returns the same job;
(d) invalid model output fails the job and saves nothing.

## Live run (manual, owner's own PC only)

`live-run.mts` is not a test. It refuses to run unless `ALLOW_CLAUDE_EXECUTION=true`, `CLAUDE_TERMS_ACK=true`, `PERSONAL_OWNER_USER_ID` is set,
`PROVIDER_MODE` is `mixed` or `live`, and `AI_MAX_LIVE_LEGS` is at most 6. The real runner comes only from `apps/ai-local/src/runner-factory.ts`;
the script starts no process. The shared server runs in process on an in-memory DB, so nothing is kept after the run.

    ALLOW_CLAUDE_EXECUTION=true CLAUDE_TERMS_ACK=true PERSONAL_OWNER_USER_ID=<your user id> \
    PROVIDER_MODE=mixed AI_MAX_LIVE_LEGS=4 \
    node --import tsx tests/e2e/generation/live-run.mts --area 金沢 --area <取得不可と思われる地域>

`PROVIDER_MODE=mixed|live` needs `GOOGLE_MAPS_SERVER_KEY` (environment or `.env`). Output is a redacted summary: counts, dataStatus, warnings (place names masked), timings, error codes.
Paste only that summary below.

## Live results

- 実施日・PC・CLI：2026-10-25、M4 本人の PC（WSL2）、Claude Code `2.1.301 (Claude Code)`。owner 本人のアカウントで実行し、第三者の要求は中継していません。
- 設定：`PROVIDER_MODE=mixed`（場所は fixture、経路は live の Google Routes）、`AI_MAX_LIVE_LEGS=4`、`CLAUDE_MODEL=sonnet`。
- 動いた代表例（金沢、1日、transit）
  - 結果は `succeeded` で、K08 で取得できました。
  - 候補は3件で、すべて `needs_review` です。場所は5件で、`dataStatus` はすべて `fixture` です。
  - 費用が分かっている活動は 0/5 で、`hasUnknownCost=true` です。
  - 移動区間
    - 区間の `fare` と `platform` はすべて null で、推測による補完はありません。
    - 金沢市内の公共交通は、Google Routes が対応していない地域です（`unsupported_region`、A06 の live 確認と同じ）。そのため移動時間は不明で、時刻は未定のままにしています。
    - 警告として「移動時間不明のため時刻未定」「移動情報は表示時に再取得」「営業時間が未取得」などが出ます。
- 取得できない地域（稚内）
  - `state=failed`、`stage=collecting_context`、`errorCode=CONSTRAINT_UNSATISFIED`、`retryable=false` で、約1秒で終わりました。
  - モデルは呼んでおらず、保存もしていません。成功と偽っていません。
- 問題点
  - BUG-I02 はありません。
  - 国内の公共交通は、地域によって Google Routes から取得できません。デモで時刻付きの旅程を見せるなら、`transportMode: car` にするか、公共交通が取得できる地域を使ってください。A04 の mixed 実行（車）では、live 経路が6回取得できています（docs/claude-connection-check.md）。

## Live results: A04 grouping (#28, after #164)

- 実施日・PC・CLI：2026-10-25、M4 本人の PC（WSL2）、owner 本人のアカウントで実行しました。M1 の承認（#28）の範囲で、Routes は上限6回（`AI_MAX_LIVE_LEGS=6`）です。
- 設定：`PROVIDER_MODE=mixed`（場所は fixture、経路は live）、`CLAUDE_MODEL=sonnet`、金沢・1日・transit。
- 結果：`succeeded`、約14秒。K08 で取得できました。候補は3件で、すべて `needs_review` です。場所は7件で、すべて `fixture` です。
  - 各候補の予定は7件、移動区間は2〜3件で、移動区間はすべて `dataStatus=unknown`（所要時間・運賃・ホームは null）でした。
  - `grouping: children=0 parents=0` が3候補とも同じでした。親子のまとめは **live では確認できていません**。
  - `mealAfterMeal=false` が3候補とも同じでした（食事の直後に食べ物の予定はありません）。
  - 警告に「移動時間不明のため時刻未定」と「〇〇の開始・終了時刻が未定のため検証できません」が出ています。最初の不明な区間から先の予定は時刻がありません。D06 の `groupNearby` は、時刻が不明な予定を `time_unknown` として飛ばすため、まとめが起きなかったと考えられます（要約には `skipped` の理由を出していないので、推定です）。
- 問題点
  - 金沢の近い地点どうしは徒歩の区間になりますが、この実行では徒歩の区間も所要時間が取れませんでした。取れなかった理由（Google が返さなかったのか、呼び出しの上限6回に達したのか）は、この要約からは分かりません。
  - 移動時間が分からないと時刻が決まらず、親子のまとめも働きません。live で R4 を見せるには、移動時間が取れる条件（車、または経路が取れる地域）で実行するか、時刻が不明でも近い予定をまとめるように D06 の規則を見直す必要があります。
