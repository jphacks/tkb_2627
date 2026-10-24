#!/usr/bin/env node
// Claude Code SessionStart hook (.claude/settings.json): reminds every member's Claude of the deadline and team rules.
// Prints only; never fails the session. Optional: lists the caller's open Issues when `gh` is logged in.
import { execFileSync } from 'node:child_process';

const DEADLINE = '2026-10-25T15:00:00+09:00';
const left = Math.round((Date.parse(DEADLINE) - Date.now()) / 60000);
const lines = [
  `【tkb_2627 チームルール（M1・利用者の指示）】締切：10/25 15:00 JST（残り ${left > 0 ? `${Math.floor(left / 60)}時間${left % 60}分` : '締切を過ぎています'}）`,
  '1. 手を止めない：自分のタスクが待ちなら、DEVELOPMENT_GUIDE.html の READY のタスクを、他の人の担当でも開始ログを書いて取る（#121）',
  '2. 進捗を必ずGitHubに残す：着手したら Issue に開始ログ（taskId・branch・writePaths）と status:doing、PRを出したら status:review、引継ぎは1コメントにまとめる',
  '3. UIを作る・直すときは docs/ui/reviews/ と Issue のレビューコメントの要望を必ず守る（R1 ドラッグ、R2 1段下の詳細、R3 n行×2列の表、R4 同じエリアは入れ子、R5 地点リストなし）',
  '4. 画面レビュー（npm run review → REVIEW.md）：M1=U08 #36・E01 #37、M2=U04 #32・U06 #34、M3=U03 #31・U07 #35、M4=U05 #33',
  '5. トークン節約：Agentは model を指定（実装・UI・テストは sonnet、doc-checker は haiku）。reviewer は1PRに1回',
];
try {
  const me = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const mine = execFileSync('gh', ['issue', 'list', '--repo', 'jphacks/tkb_2627', '--assignee', me, '--state', 'open', '--json', 'number,title,labels', '--jq', '.[] | "#\\(.number) \\(.title) [\\([.labels[].name|select(startswith("status:"))]|join(","))]"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (mine) lines.push(`あなた（${me}）の未完了のIssue:`, ...mine.split('\n').map(l => `  ${l}`));
} catch { /* gh not available or offline: rules only */ }
console.log(lines.join('\n'));
