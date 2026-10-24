# A01 本人のClaude Code接続と利用条件の確認

担当：M4（poyyk）／Issue #25／要件 R27／契約 K03・K04
記録日：2026-10-24（JST）。下記は**M4のPC1台**での結果で、他メンバーのPCは各自で`node packages/ai/probes/claude-probe.mjs`を実行して確認する。

## 結論
| 用途 | 判定 | 根拠 |
|---|---|---|
| 本人PCの`127.0.0.1:4311`で、本人が本人のPro/Maxログイン済み公式CLIを使い自分の旅程を生成 | **条件付きで可** | 本人のサブスクで未改変CLIへサインインする利用は禁止対象外（下記①③）。通常の個人利用の範囲に限る（②）。 |
| 共有URL（:4310、HTTPS公開）の利用者・審査員・他メンバーの要求で、ホストのProを使って生成 | **不可** | 「Free/Pro/Max資格情報で利用者に代わって要求を中継」禁止（①）。K22の`SHARED_ENTRY_NO_PERSONAL_CLAUDE`を維持。 |
| Claude OAuth tokenの読出し・保存・移送、Agent SDKへのsubscription token流用 | **不可** | ①。アプリは`claude`プロセスを起動するだけで認証情報を一切扱わない。 |
| `--bare`、`ANTHROPIC_API_KEY`、apiKeyHelperへの切替え | **既定にしない／無断で行わない** | `--bare`はOAuthを読まずAPIキー課金になる（④）。API課金はCLAUDE.md §2で禁止。 |

最終的な利用可否はM4本人とM1が下記条件を読んで同意し、Issue #25にコメントしてから`ALLOW_CLAUDE_EXECUTION=true`の実装（A04）へ進む。それまでApp Serverは`TERMS_NOT_CONFIRMED`扱いで実CLIを起動しない。

### 出典（2026-10-24取得）
1. Claude Code Docs「Legal and compliance」― Authentication and credential use：OAuth認証はサブスク購入者による*ordinary use*のため。開発者がclaude.aiログインを自アプリに提供すること、Free/Pro/Max資格情報で利用者に代わって要求を中継すること、claude.aiの資格情報やセッショントークンを収集・保存・中継することは禁止。<https://code.claude.com/docs/en/legal-and-compliance>
2. 同ページ Acceptable use：Pro/Maxの公表上限は*ordinary, individual usage*が前提。Free/Pro/MaxはConsumer Terms、API・Team・EnterpriseはCommercial Terms。
3. 同ページ：エンドユーザーが自分のサブスクで未改変のClaude Codeにサインインすることは妨げない。CLIの改変・認証手段の除去は禁止。
4. Claude Code Docs「Run Claude Code programmatically」：`-p`の`--output-format json`＋`--json-schema`で`structured_output`。妥当な構造化出力がない場合はフィールド自体がない。`--bare`はOAuth/キーチェーンを読まず`ANTHROPIC_API_KEY`等が必要。`--bare`なしの`-p`はcwdの`.claude/settings.json`のhooksや`.mcp.json`、`~/.claude`をtrust確認なしで読み込む。<https://code.claude.com/docs/en/headless>

## 守る制約（A02〜A06の実装条件）
- 実行するのは**本人入口（loopbackの:4311）だけ**。ペアリング済みのローカルセッションで、本人allowlistに入っている利用者の要求に限る。共有サーバーから本人CLIへの逆proxyやジョブ取得は作らない。
- 起動方法：固定の実行ファイル（`CLAUDE_BIN`）、引数配列、`shell:false`。promptはstdinで渡す（stdinの上限は10MB）。
- 隔離：`-p`では`--bare`なしでもhooks・MCP・CLAUDE.mdを読み込むため、**空の専用cwd**（毎回作成して削除）、`--tools ""`、`--strict-mcp-config`（`--mcp-config`は指定しない）、`--no-session-persistence`を使う。`~/.claude/settings.json`のhooksとプラグインは本人が確認する（M4のPCでは`model`と`effortLevel`だけでhooksはない）。`--setting-sources`で`user`を外すかどうかは、サブスク認証が維持されるかを実機で確かめるまで未確定。ツールを無効にしても完全に隔離できたとは見なさない。
- 起動前に検証して拒否する条件：`ANTHROPIC_API_KEY`／`ANTHROPIC_AUTH_TOKEN`／`ANTHROPIC_BASE_URL`／`CLAUDE_CODE_OAUTH_TOKEN`／`CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`のいずれかが設定されている、または`claude auth status --json`の`authMethod`が`claude.ai`でない場合は実行しない（API課金や別の経路にしない）。子プロセスにはこれらの変数を渡さない環境を組み立てる。
- 出力の扱い：exit codeが0、`type=result`、`is_error=false`、`subtype=success`、`structured_output`ありの**すべて**を満たす場合だけ受け取り、さらに`parseBlueprint`でschemaと許可された地点IDを検証する。`total_cost_usd`はクライアント側の推定値なので課金の根拠にしない。
- 失敗の分類（K23/SafeError）：CLIが見つからない→`CLI_NOT_FOUND`（capabilities）、未ログイン→`CLI_NOT_AUTHENTICATED`、利用枠超過→`CLI_LIMIT`（APIへ切り替えない・無限リトライしない）、timeout→`CLI_TIMEOUT`（SIGTERMの場合はexit 143）、0以外で終了→`CLI_EXIT`、JSON不正や`structured_output`なし→`INVALID_OUTPUT`。stderrの生の内容はUIやログに出さない。
- 負荷：初期値は同時実行1・待機8・全体300秒・CLI120秒・形式修復1回（docs/00_DECISIONS.md）。個人の通常利用の範囲に収める。

## 実機での確認結果（M4のPC、fixtureではなくlive）
コマンド：`node packages/ai/probes/claude-probe.mjs --live`（出力にメールアドレスや組織ID、tokenは含まれない）

| 項目 | 結果 |
|---|---|
| OS／Node | linux-x64（WSL2）／v22.22.3 |
| CLIの版 | `2.1.301 (Claude Code)` |
| help上のフラグ | `--print`, `--output-format`, `--json-schema`, `--tools`, `--strict-mcp-config`, `--no-session-persistence`, `--model`, `--bare`：すべて存在 |
| 認証 | `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`, `subscriptionType=pro` |
| API課金系の環境変数 | 上記7個すべて未設定 |
| 構造化出力（1回） | exit 0、所要約3.2秒、stderr 0バイト、`type=result`／`subtype=success`／`is_error=false`／`num_turns=2`、`structured_output`がschemaに一致 |
| 不正なschema | `--json-schema '{"type":"nope"}'`→モデル呼出しの前にexit 1、stderrに`Error: --json-schema is not a valid JSON Schema…`、stdoutは空 |

envelopeのキー（2.1.301）：`type, subtype, is_error, result, structured_output, num_turns, stop_reason, terminal_reason, api_error_status, session_id, uuid, usage, modelUsage, total_cost_usd, duration_ms, duration_api_ms, permission_denials`ほか計34個。版が変わるとキーが増減するため、パーサーは上の必須キーだけに依存する。

## 未確認（実装済みとしない）
- 未ログイン・利用枠超過・ネットワーク断の実際のenvelope／exit code：意図的に再現していない。docs上は「実行中の失敗はstdoutのresultとして出力される」とあるため、A02/A03ではfake runnerで模擬し、実機の値は見つかり次第この表へ追記する。
- macOS（M1）や他メンバーのPCでの結果。
- `--setting-sources`の指定とサブスク認証の両立。
- 旅程規模のprompt（GenerationInput）での所要時間と利用枠の消費量（A04で計測）。

## 再現方法
```
node packages/ai/probes/claude-probe.mjs          # モデルは呼ばない（版・フラグ・認証方式だけ）
node packages/ai/probes/claude-probe.mjs --live   # 本人のProで最小1回だけ呼ぶ
```
`--live`は、API課金系の環境変数が設定されているか、認証がclaude.aiでない場合は実行を拒否する。
