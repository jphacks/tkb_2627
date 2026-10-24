# tkb_2627 — 4人開発セットアップと日常運用 v5

前提：**各自のPCでgitの`tkb_2627`リポジトリは既に接続済み**。`git init`、新しいclone、repo新規作成は不要です。`OWNER`は確認した所有者名、`DEFAULT_BRANCH`は`gh repo view`の実値に置換してください。最初にGitルートとoriginを照合し、他のrepositoryを書き換えません。

## 作業前のファイル構成

- M1用の初回資料と機能仕様は`CLAUDE.md`、`prompts/M1_START.txt`、`docs/00_DECISIONS.md`。
- M2/M3/M4は、M1の基点が共有された後、各自の`prompts/M2_START.txt`などを読む。
- Agentの役割は`.claude/agents/`、使いどころは`docs/11_AGENT_DISPATCH.md`。
- 進捗・引継ぎはGitHub Issue、採用済み仕様はGit、コードはPR、HTMLは閲覧用です。

## START01 4人とも既存のtkb_2627フォルダと認証を確認

担当：M1, M2, M3, M4。開発開始前。全員が自分のPCで行う。

- 各自のPCで既存の`tkb_2627`のGitルート・remote・未commit変更を確認。新規clone不要。
- GitHub CLI、Node.js、Claude Codeの本人のログインを確認。他人の認証は使わない。

```bash
cd tkb_2627
git rev-parse --show-toplevel
git remote -v
git status --short
gh auth status
claude --version
```

**期待結果：** 全員が各PCのtkb_2627からGitHubリポジトリtkb_2627に接続できる。認証情報を表示・共有しない。

**失敗時：** Gitルートやoriginの名前が違う場合は作業を止めて本人が接続を修正。未commit変更は消さない。

**次：** M1はSTART02、他の3人は招待承認後START06へ。

## START02 M1が既存tkb_2627の権限と3名の招待を確認

担当：M1。既にGitHub remote接続済み。cloneはしない。

- 既存originの末尾がtkb_2627、Gitルートの末尾がtkb_2627であることを確認。
- GitHubのSettingsから残り3人を招待し、各自の承認が完了したか確認。

```bash
cd tkb_2627
git remote get-url origin
git rev-parse --show-toplevel
gh repo view --json nameWithOwner,defaultBranchRef,viewerPermission
git status --short
```

**期待結果：** GitHub側と4台のローカル側に同一リポジトリtkb_2627が接続済み。owner、default branch、編集権限を取得。

**失敗時：** remoteが不一致なら自動修正せず停止。招待未承認ならそのメンバーの作業開始だけ待つ。

**次：** START03。どのPCでもcloneし直さない。

## START03 M1が既存tkb_2627へ設計キットを安全に配置

担当：M1。M1だけが実行。他の3人は初期化しない。

- M1だけが、ZIPをtkb_2627と同じ親ディレクトリに展開した設計キットからplace-kitを使用（dry-runが先）。
- 既存READMEや.gitignoreに衝突があれば中断して差分を見て合成。未commit変更は破棄しない。
- 配置後、tkb_2627でClaude Codeへprompts/M1_START.txtを読ませる。マスターは初期構築者用のみ。

```bash
cd tkb_2627
node ../tkb_2627_bootstrap_v5/scripts/place-kit.mjs --target . --expect-repo tkb_2627
node ../tkb_2627_bootstrap_v5/scripts/place-kit.mjs --target . --expect-repo tkb_2627 --apply
node scripts/check-repo.mjs
claude
```

**期待結果：** 設計資料と6つのAgentがtkb_2627直下に配置され、Claude Code起動時に読込可能。既存データに変更なし。

**失敗時：** 衝突したファイル名を確認。`--apply --skip-conflicts`で不足ファイルだけ追加することは可能ですが、スキップした既存README等はM1が差分を安全に統合するまで設定完了としません。上書きやリセットは禁止。

**次：** Claudeへ「prompts/M1_START.txt、CLAUDE.md、docs/11_AGENT_DISPATCH.mdを読んでB01から開始」と送る。

## START04 共通型と動く骨格を最初に共有する

担当：M1。B01→B02/B03。設計だけを続けずUIを動かす。

- M1がpackages/contracts、アプリ骨格、認証前のfixture、アプリ用setup/dev/testコマンドを作る。
- 最初のUIは外部API・Claudeの実接続を待たない。M2が画面を触れる起点を先に渡す。
- 既存default branchにPRで統合。完全に空のrepoだけは、初回の基点commit作成を所有者承認のうえ1回行う。

```bash
git status --short
git switch -c bootstrap/tkb2627-base
git add <reviewed-paths>
git diff --cached
git commit -m "chore: bootstrap tkb_2627"
git push -u origin bootstrap/tkb2627-base
gh pr create --title "Initial tkb_2627 skeleton" --body-file .local/bootstrap-pr.md
```

**期待結果：** 既存tkb_2627リポジトリのdefault branchに、M2〜M4がfetchできる契約と画面骨格がPRで統合済み。

**失敗時：** 現在ブランチ/差分/default branchを検査。ルートcommit未作成の完全空repoの場合は所有者承認を得た初回pushに変更し、その後PR運用。

**次：** START05でIssue化。M2〜M4はSTART06へ。

## START05 役割の対応表と全タスクをGitHubへ登録する

担当：M1。G01→G02。タスクの重複作成を防ぐ。

- ops/team.example.jsonを元にops/team.jsonを作り、M1〜M4とGitHub loginを記載。パスワードやtokenは入れない。
- まずinitのdry-runを確認。--applyはIssue/labelを書き込むためM1だけが実行。Projectsは任意ビューで、Issueのstatusラベルを正本にする。

```bash
gh repo view --json nameWithOwner
node scripts/github-sync.mjs init --repo OWNER/tkb_2627
node scripts/github-sync.mjs init --repo OWNER/tkb_2627 --apply
node scripts/github-sync.mjs snapshot --repo OWNER/tkb_2627
npm run guide
```

**期待結果：** 各taskIdに1つのIssue。lane:M1等、status:todo等、依存リンク、受入条件が記載される。

**失敗時：** 認証・権限不足ならそこで止める。既存Issueはmarkerで識別し、同じ名前だけで再利用しない。native dependencies未対応なら本文リンクを使う。

**次：** 全員がSTART07の読取り同期へ。

## START06 M2〜M4が既存tkb_2627でfetchして参加

担当：M2, M3, M4。既に各PCでorigin接続済み。M1の基点がdefault branchへ統合後。

- 各自の招待承認、GitHub認証、Claude Code認証を確認。既存tkb_2627をcloneし直さない。
- 未commit変更がないか確認してからfetchし、最新のorigin default branchの初期基点をローカルへ安全に取り込む。
- 各自の担当別プロンプトとCLAUDE.mdを読んで担当Issueを開始する。

```bash
cd tkb_2627
git status --short
git fetch origin
git remote show origin
git pull --ff-only
npm run check
claude
```

**期待結果：** 既存tkb_2627の同一履歴に最新の設計とAgent定義が入り、担当別プロンプトを読める。

**失敗時：** 現在ブランチに追跡先がない場合はpullを繰返さず、default branchを確認して正しくcheckout。履歴不一致や未commit差分がある場合は破壊的操作をしない。

**次：** M2はprompts/M2_START.txt、M3はM3_START.txt、M4はM4_START.txtを読ませる。

## START07 作業開始前に最新の仕様・担当・進捗を読む

担当：M1, M2, M3, M4。各作業の開始時、依存完了通知時、再開時。

- default branchをfetchし、対象Issueと依存Issueを直接読む。HTMLの古いスナップショットだけで判断しない。
- 仕様/型の正本はGit、作業状態と相談はIssue/PR。チャットやAgentの私有メモだけに決定を残さない。

```bash
git fetch origin
git status --short
gh issue view ISSUE_NUMBER --comments
node scripts/github-sync.mjs snapshot --repo OWNER/tkb_2627
npm run guide
```

**期待結果：** 自分の担当・依存のmerge commit・受入条件・変更範囲が一致。HTMLに取得時刻が表示される。

**失敗時：** 取得失敗なら古い情報と表示し新担当を勝手にclaimしない。他メンバーのブランチへgit pullしない。

**次：** START08で自分の作業場所を作る。

## START08 1タスク・1担当の作業場所を作る

担当：M1, M2, M3, M4。Issueの担当者が自分で、依存が統合済みになったら。

- M1が担当の変更を調整。Issueのassign操作は分散lockではない。競合したら両者停止しM1が決める。
- ブランチとWorktreeをタスク単位で分ける。共有型・migration・lockfileを同時に編集しない。

```bash
git worktree add -b feat/m2/u01 ../travel-u01 origin/DEFAULT_BRANCH
cd ../travel-u01
gh issue edit ISSUE_NUMBER --remove-label "status:todo" --add-label "status:doing"
gh issue comment ISSUE_NUMBER --body "開始: M2 / U01 / feat/m2/u01 / 変更範囲 apps/web"
```

**期待結果：** 誰がどのbranch・pathを作業しているか他3人もIssueで確認できる。

**失敗時：** branchが存在する場合は内容を確認して再開。forceで再作成しない。担当不一致はM1へ依頼。

**次：** START09で実装・テスト・こまめなpush。

## START09 小さな変更ごとにpushし、引継ぎを残す

担当：M1, M2, M3, M4。機能片、テスト成功、離席前。長い作業は15〜30分のチェックポイント。

- 差分と秘密情報を確認してcommit。main統合とは別の作業ブランチ保存。
- Issueへ結果を短く報告。pushしただけで依存先を完了扱いにしない。

```bash
git diff
git add <reviewed-paths>
git diff --cached
git commit -m "feat(U01): editable itinerary prototype"
git push -u origin feat/m2/u01
gh issue comment ISSUE_NUMBER --body-file .local/handoff.md
```

**期待結果：** Issueにcommit、変更path、実行コマンドと結果、fixture/live、次の作業、相談先がある。

**失敗時：** テスト失敗を隠さずWIPとして作業branchへ保存。秘密情報混入時はpush前に修正。force pushは禁止。

**次：** START10で独立レビュー。

## START10 別レビューとPRで統合する

担当：M1, M2, M3, M4。担当の局所テストが成功したら。

- 実装者とは別コンテキストのreviewer Agentで点検。人間のreview担当も確認。
- M1が同時統合を直列化し、最新default branchに対するテスト後にmerge。CIと受入証拠なしにdoneへしない。

```bash
gh pr create --base DEFAULT_BRANCH --head feat/m2/u01 --title "U01 first prototype" --body-file .local/pr.md
gh pr checks PR_NUMBER
gh pr view PR_NUMBER --comments
gh pr merge PR_NUMBER --squash
```

**期待結果：** merge SHA、テスト結果、要件ID、UI人間承認の要否を記録。M1だけがstatus:doneとcloseを確定。

**失敗時：** 競合はpath所有者と修正。人間承認をAgentが偽造しない。保護ルールを無断解除しない。

**次：** START11で後続へ通知。

## START11 変更を他3人へ渡す

担当：M1, M2, M3, M4。共通型・API・依存タスクのmerge後。

- M1が影響するIssueへmerge SHA、schemaVersion、移行方法をコメントし担当をmention。
- 利用側は新規worktreeなら新mainを起点にし、既存作業はworking treeをcleanにしてorigin/DEFAULT_BRANCHをmergeする。自動resetは禁止。

```bash
git fetch origin
git status --short
git merge origin/DEFAULT_BRANCH
node scripts/github-sync.mjs snapshot --repo OWNER/tkb_2627
npm run guide
```

**期待結果：** 実装者だけが知る変更を残さず、利用側の契約テストが通る。

**失敗時：** 互換性破壊は先にcontract変更Issue。画面だけ直し、server側を放置しない。

**次：** 次のreadyタスクへ。

## START12 UIを人間に見せ、判断だけを記録する

担当：M2, M1。U01が操作可能になったら。backendを止めない。

- M2が画面URL・操作手順・スクリーンショット・確認点をUI Issueへ。
- ユーザーの回答を画面別に承認/要修正/保留として記録。未回答を承認にしない。
- 受渡し形式が変わる場合だけM1へcontract変更依頼。色や余白の修正でM3/M4を待たせない。

```bash
gh issue comment UI_ISSUE_NUMBER --body-file .local/ui-review.md
```

**期待結果：** 画面の版、確認者、判断日、変更理由、再確認条件が残る。U02を人間判断なしでdoneにしない。

**失敗時：** 実データが未接続ならfixtureと画面に表示。UIの見栄えだけで機能完了としない。

**次：** M2は合意部分を実装。M1/M3/M4は独立タスク継続。

## START13 アプリを起動して同じ版を確認する

担当：M1, M2, M3, M4。M1がsetup/dev等を実装しREADMEで存在を確認した後。

- キットのnpm testと旅行アプリのテストを混同しない。npm runで存在するscriptsを確認。
- 共有4310、本人4311、UI開発ポートは選定した構成に従う。スマホ共有URLはSNS/保存用で、本人CLIを遠隔提供しない。

```bash
npm run
npm ci
npm run setup
npm run dev
npm run test:unit
npm run test:e2e
```

**期待結果：** 画面が開き、fixtureで旅程保存と2ユーザーSNS操作ができる。実接続はtest:liveの明示許可後。

**失敗時：** 現在配布のキットだけではsetup/devは未実装。存在しないコマンドを何度も実行せずM1の骨格タスクを確認。

**次：** START14で共有デモ。

## START14 共有デモを公開し、本人用AIを閉じたまま確認

担当：M1。共有サーバーの認可・秘密情報試験後。

- 共有サーバーだけをHTTPS公開。DB、本人4311、GitHub認証、開発者用管理画面は公開しない。
- 本人PCでは生成→保存。別ユーザー端末では閲覧・group・コピー・編集を確認。生成の第三者提供まで成功したと報告しない。

```bash
npm run build
npm run start:shared
cloudflared tunnel --url http://127.0.0.1:4310
```

**期待結果：** HTTPS共有URLをスマホで開ける。非公開投稿は別ユーザーから404。PC停止後は利用できないことを説明。

**失敗時：** cloudflaredは別途導入。固定URLが必要なら所有ドメインと設定を確認。PCの全ポートを外部公開しない。

**次：** 残る未達・許諾・実データ未検証を一覧で引継ぐ。
