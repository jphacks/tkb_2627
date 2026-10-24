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
