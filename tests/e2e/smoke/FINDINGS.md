# I01 findings (first save, end to end)

Scope: R25, R26, R29. This is not a claim that AI generation or the real screen path is complete.

## What is covered (tests/e2e/smoke/first-save.test.ts)
- Layer 1: apps/server runs as a child process (`node --import tsx apps/server/src/main.ts`) on a free port with a temp file DB.
  login (cookie + csrf) -> K07 plan-batches (domesticTrip as the candidate) -> K08 apply-candidate -> K09 list and detail.
  The process is then stopped and restarted on the same DB; a new login reads an identical Trip (R25).
  Another user gets 404 on the trip (same body as a missing id) and an empty list (R26).
- Layer 2: the mock API (apps/web/src/mocks) and the real server both parse with the contracts `Trip` / `TripList`.
  tripId, title, revision, days[].items, validationState and warnings exist in both, and the top-level keys, day keys,
  item types and list item keys are identical.

## Skipped
- "serves the web build at / with 200" is `it.skipIf`: apps/web/dist does not exist in this worktree, and this task does not run a build.
  Run `npm run build` first to enable it (static delivery itself is covered by apps/server/test/static.test.ts).

## Mock display is still in place (confirmed from source)
- apps/web/src/App.tsx renders a `FIXTURE` banner (`FIXTURE_NOTICE`) on top of the screens.
- The screens take a MockApi (apps/web/src/screens/TripDetailEdit.tsx imports `MockApi`) and show `MOCK_NOTICE`
  ("モックAPIのデータです。実際の保存・生成・通信は行っていません。") and "出典: mock";
  apps/web/src/screens/render.test.tsx asserts both.
- No screen calls the real API. Connecting the screens to the real server is M2 (U03 onward). Not done here.

## Observations (no defects found)
- No implementation code was changed. No test was skipped for a defect.
- The test uses a fixed SESSION_SECRET only so CSRF tokens would stay valid across the restart. Sessions are stored in the DB.
- `test:e2e` is also matched by `vitest run` (test:unit) because vitest.config.ts include now has tests/e2e, as instructed.
  It starts a server process, so test:unit takes about 2 s longer.
