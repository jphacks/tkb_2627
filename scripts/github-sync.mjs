import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, loadInputs, validatePlan, normalizeRepo, issueIndex, marker, taskBody, mergeGeneratedBody, issueState, writeJsonAtomic } from './lib.mjs';

const args = process.argv.slice(2), mode = args[0];
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
function gh(a) {
  const r = spawnSync('gh', a, { cwd: ROOT, encoding: 'utf8', timeout: 60000, maxBuffer: 20 * 1024 * 1024, shell: false });
  if (r.error || r.status !== 0) throw new Error(`GitHub CLI failed (${a[0] ?? ''} ${a[1] ?? ''}): ${(r.stderr || r.error?.message || '').trim().slice(0, 500)}`);
  return r.stdout.trim();
}
function checkRemote(repo) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', timeout: 10000, shell: false });
  if (r.status !== 0) throw new Error('No origin found. Run in the existing repository checkout; no new repository will be created.');
  if (normalizeRepo(r.stdout).toLowerCase() !== repo.toLowerCase()) throw new Error('Requested repository does not match origin. Refusing remote changes.');
}
function fetchIssues(repo) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,title,body,state,labels,url,assignees']));
  if (issues.length >= 1000) throw new Error('Issue listing may be incomplete. Refusing to infer missing tasks; use explicit pagination before continuing.');
  return issues;
}
function saveSnapshot(repo, issues, plan) {
  const index = issueIndex(issues), tasks = {}, warnings = [];
  for (const t of plan.tasks) {
    const issue = index.get(t.id);
    if (!issue) continue;
    const status = issueState(issue);
    if (status.warning) warnings.push(`${t.id}: ${status.warning}`);
    tasks[t.id] = { status: status.status, issue: { number: issue.number, url: issue.url, assignees: issue.assignees?.map(a => a.login) ?? [] } };
  }
  const snapshot = { repository: repo, fetchedAt: new Date().toISOString(), warnings, tasks };
  writeJsonAtomic(path.join(ROOT, '.local/github-snapshot.json'), snapshot);
  console.log(`Snapshot saved: ${Object.keys(tasks).length}/${plan.tasks.length} tasks. Warnings: ${warnings.length}`);
  return snapshot;
}
try {
  if (!['init', 'snapshot'].includes(mode)) throw new Error('Usage: node scripts/github-sync.mjs init|snapshot --repo OWNER/REPO [--apply]');
  const repo = normalizeRepo(flag('--repo'));
  const { plan, requirements } = loadInputs();
  const errors = validatePlan(plan, requirements);
  if (errors.length) throw new Error(errors.join('\n'));
  if (mode === 'init' && !args.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'PLAN_ONLY_NO_NETWORK', repository: repo, wouldInspect: plan.tasks.length,
      note: 'Existing issues, permissions and exact changes are unknown until --apply. Only M1 should apply.',
      tasks: plan.tasks.map(t => ({ id: t.id, owner: t.owner, title: t.title, dependsOn: t.dependsOn })) }, null, 2));
    process.exit(0);
  }
  checkRemote(repo);
  gh(['auth', 'status']);
  if (mode === 'snapshot') { saveSnapshot(repo, fetchIssues(repo), plan); process.exit(0); }
  const existingIssues = fetchIssues(repo), index = issueIndex(existingIssues);
  const sharedTeam = path.join(ROOT, 'ops/team.json');
  const teamFile = fs.existsSync(sharedTeam) ? sharedTeam : path.join(ROOT, '.local/team.json');
  const team = fs.existsSync(teamFile) ? JSON.parse(fs.readFileSync(teamFile, 'utf8')) : null;
  if (team?.repository && normalizeRepo(team.repository).toLowerCase() !== repo.toLowerCase()) throw new Error('Team mapping repository mismatch');
  const knownLabels = new Set(JSON.parse(gh(['label', 'list', '--repo', repo, '--limit', '200', '--json', 'name'])).map(l => l.name));
  const labels = [['jh:task', '16324F'], ...plan.owners.map(o => [`lane:${o}`, 'D6EAF8']), ...['todo','doing','review','done','blocked'].map(s => [`status:${s}`, s === 'done' ? '238636' : s === 'blocked' ? 'B33A3A' : '59636E'])];
  for (const [name, color] of labels) if (!knownLabels.has(name)) gh(['label', 'create', name, '--repo', repo, '--color', color, '--description', 'JPHacks design kit managed label']);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jphacks-issues-'));
  try {
    for (const t of plan.tasks) {
      if (index.has(t.id)) continue;
      const bodyFile = path.join(tempDir, `${t.id}.md`);
      fs.writeFileSync(bodyFile, taskBody(t), { mode: 0o600 });
      const create = ['issue', 'create', '--repo', repo, '--title', `[${t.id}] ${t.title}`, '--body-file', bodyFile,
        '--label', 'jh:task', '--label', `lane:${t.owner}`, '--label', 'status:todo'];
      const assignee = team?.members?.[t.owner]?.github;
      if (assignee) {
        if (!/^[A-Za-z0-9-]{1,39}$/.test(assignee)) throw new Error(`Invalid GitHub username for ${t.owner}`);
        create.push('--assignee', assignee);
      }
      const output = gh(create);
      const m = output.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/);
      if (!m) throw new Error(`Issue creation returned an unexpected response for ${t.id}. Stop and inspect existing issues before retrying.`);
      index.set(t.id, { number: Number(m[1]), body: taskBody(t), url: m[0], state: 'OPEN', labels: [{ name: 'status:todo' }] });
      console.log(`Created ${t.id}: #${m[1]}`);
    }
    let supportDeps = false;
    try { supportDeps = gh(['issue', 'edit', '--help']).includes('--add-blocked-by'); } catch {}
    for (const t of plan.tasks) {
      const issue = index.get(t.id), file = path.join(tempDir, `${t.id}.md`);
      const body = mergeGeneratedBody(issue.body ?? marker(t.id), taskBody(t, index, repo), t.id);
      if (body !== issue.body) {
        fs.writeFileSync(file, body, { mode: 0o600 });
        gh(['issue', 'edit', String(issue.number), '--repo', repo, '--body-file', file]);
      }
      if (supportDeps && t.dependsOn.length) {
        try {
          const details = JSON.parse(gh(['issue', 'view', String(issue.number), '--repo', repo, '--json', 'blockedBy']));
          const raw = details.blockedBy?.nodes ?? details.blockedBy;
          if (!Array.isArray(raw)) throw new Error('Unknown blockedBy response shape');
          const present = new Set(raw.map(x => x.number));
          const missing = t.dependsOn.map(d => index.get(d).number).filter(n => !present.has(n));
          if (missing.length) gh(['issue', 'edit', String(issue.number), '--repo', repo, '--add-blocked-by', missing.join(',')]);
        } catch (e) { console.warn(`Native dependencies not confirmed for ${t.id}; body links retained. ${e.message}`); }
      }
    }
    if (!supportDeps) console.warn('This gh version does not advertise --add-blocked-by. Task JSON and issue body links retain dependencies.');
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  saveSnapshot(repo, fetchIssues(repo), plan);
  console.log('No repository was created. No invitations, branch protection, commits or pushes were performed.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
