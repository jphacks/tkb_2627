import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATUS = ['todo', 'doing', 'review', 'done', 'blocked'];
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function loadInputs(root = ROOT) {
  return { plan: readJson(path.join(root, 'ops/tasks.json')), requirements: readJson(path.join(root, 'ops/requirements.json')) };
}
export function validatePlan(plan, requirements) {
  const errors = [];
  if (!Array.isArray(plan?.tasks) || !Array.isArray(requirements)) return ['Invalid plan structure'];
  const ids = new Set(), reqIds = new Set();
  for (const r of requirements) {
    if (!/^R\d{2}$/.test(r.id) || reqIds.has(r.id)) errors.push(`Invalid or duplicate requirement: ${r.id}`);
    reqIds.add(r.id);
  }
  for (const t of plan.tasks) {
    if (!/^[A-Z]\d{2}$/.test(t.id) || ids.has(t.id)) errors.push(`Invalid or duplicate task: ${t.id}`);
    ids.add(t.id);
    if (!plan.owners?.includes(t.owner)) errors.push(`Invalid owner: ${t.id}`);
    if (!['none', 'prototype', 'approval'].includes(t.uiDependency)) errors.push(`Invalid UI dependency: ${t.id}`);
    if (!Array.isArray(t.dependsOn) || !Array.isArray(t.requirements)) errors.push(`Invalid array: ${t.id}`);
    if (!t.acceptance?.trim() || !t.verification?.trim()) errors.push(`Missing acceptance/test: ${t.id}`);
    if (!(t.estimateMinutes?.low > 0 && t.estimateMinutes.high >= t.estimateMinutes.low)) errors.push(`Invalid estimate: ${t.id}`);
    if (!t.writePaths?.length || t.writePaths.some(p => path.isAbsolute(p) || p.split(/[\\/]/).includes('..'))) errors.push(`Invalid write paths: ${t.id}`);
    if (t.initialStatus !== 'todo') errors.push(`Design task must not be pre-completed: ${t.id}`);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn ?? []) if (!ids.has(d) || d === t.id) errors.push(`Invalid dependency: ${t.id} -> ${d}`);
    if (new Set(t.dependsOn ?? []).size !== (t.dependsOn ?? []).length) errors.push(`Duplicate dependencies: ${t.id}`);
    for (const r of t.requirements ?? []) if (!reqIds.has(r)) errors.push(`Unknown requirement: ${t.id} -> ${r}`);
  }
  for (const r of reqIds) if (!plan.tasks.some(t => t.requirements?.includes(r))) errors.push(`Uncovered requirement: ${r}`);
  if (!errors.length) {
    try { topological(plan.tasks); } catch (e) { errors.push(e.message); }
  }
  return errors;
}
export function topological(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const visiting = new Set(), visited = new Set(), out = [];
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected at ${id}`);
    const t = byId.get(id);
    if (!t) throw new Error(`Missing dependency ${id}`);
    visiting.add(id);
    for (const d of t.dependsOn) visit(d);
    visiting.delete(id); visited.add(id); out.push(t);
  }
  for (const t of tasks) visit(t.id);
  return out;
}
export function planMetrics(plan) {
  const ordered = topological(plan.tasks), levels = {}, longest = {}, laneMinutes = {};
  for (const t of ordered) {
    levels[t.id] = t.dependsOn.length ? Math.max(...t.dependsOn.map(d => levels[d])) + 1 : 0;
    longest[t.id] = (t.dependsOn.length ? Math.max(...t.dependsOn.map(d => longest[d])) : 0) + t.estimateMinutes.low;
    laneMinutes[t.owner] ??= { low: 0, high: 0 };
    laneMinutes[t.owner].low += t.estimateMinutes.low;
    laneMinutes[t.owner].high += t.estimateMinutes.high;
  }
  return { levels, laneMinutes, resourceUnconstrainedMinPathMinutes: Math.max(...Object.values(longest), 0) };
}
export function progressFor(plan, snapshot = null) {
  const states = {}, warnings = [];
  for (const t of plan.tasks) {
    const raw = snapshot?.tasks?.[t.id];
    states[t.id] = STATUS.includes(raw?.status) ? raw.status : 'todo';
  }
  const result = plan.tasks.map(t => {
    const unmet = t.dependsOn.filter(d => states[d] !== 'done');
    const status = states[t.id];
    if (status === 'done' && unmet.length) warnings.push(`${t.id} marked done with incomplete dependencies: ${unmet.join(', ')}`);
    const displayStatus = status === 'todo' ? (unmet.length ? 'waiting' : 'ready') : status;
    return { ...t, status, displayStatus, unmetDependencies: unmet, issue: snapshot?.tasks?.[t.id]?.issue ?? null, evidence: snapshot?.tasks?.[t.id]?.evidence ?? null };
  });
  return { tasks: result, warnings };
}
export function marker(id) { return `<!-- jphacks-task:${id} -->`; }
export function issueIndex(issues) {
  const out = new Map();
  for (const issue of issues) {
    const matches = [...(issue.body ?? '').matchAll(/<!-- jphacks-task:([A-Z]\d{2}) -->/g)];
    if (matches.length > 1) throw new Error(`Multiple task markers in issue #${issue.number}`);
    if (!matches.length) continue;
    const id = matches[0][1];
    if (out.has(id)) throw new Error(`Duplicate task marker ${id}: #${out.get(id).number} and #${issue.number}`);
    out.set(id, issue);
  }
  return out;
}
export function normalizeRepo(value) {
  let v = value?.trim() ?? '';
  v = v.replace(/^https:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) throw new Error('Use OWNER/REPO or a github.com repository URL without credentials');
  if (v.toUpperCase() === 'OWNER/REPO') throw new Error('Replace OWNER/REPO with the existing repository');
  return v;
}
export function issueState(issue) {
  const labels = (issue.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
  const found = labels.filter(l => l?.startsWith('status:')).map(l => l.slice(7)).filter(l => STATUS.includes(l));
  if (found.length > 1) return { status: 'blocked', warning: 'Conflicting status labels' };
  if (found[0] === 'done' && issue.state !== 'CLOSED') return { status: 'review', warning: 'Done label on open issue; verify evidence and close after review' };
  if (issue.state === 'CLOSED' && found[0] !== 'done') return { status: 'review', warning: 'Closed without explicit done label; completion is unverified' };
  return { status: found[0] ?? 'todo', warning: null };
}
export function taskBody(t, byId = new Map(), repo = null) {
  const deps = t.dependsOn.length ? t.dependsOn.map(id => {
    const issue = byId.get(id);
    return issue && repo ? `- [${id}](https://github.com/${repo}/issues/${issue.number})` : `- ${id}`;
  }).join('\n') : '- None';
  return [marker(t.id), '<!-- jphacks-generated:start -->', `# ${t.id}: ${t.title}`, '', `Planned lane: **${t.owner}**`, `UI dependency: **${t.uiDependency}**`, `Requirements: ${t.requirements.join(', ') || 'Engineering infrastructure'}`, '', '## Dependencies', deps, '', '## Write scope', ...t.writePaths.map(p => `- \`${p}\``), '', '## Acceptance', t.acceptance, '', '## Verification', t.verification, '', '## Completion evidence', '- [ ] PR reviewed and merged', '- [ ] Verification output attached', '- [ ] Live data and fixture results distinguished', '- [ ] No secrets or unauthorized provider content committed', '', 'Do not mark complete based only on code generation or a mock UI.', '<!-- jphacks-generated:end -->'].join('\n');
}
export function mergeGeneratedBody(oldBody, generated, id) {
  const start = '<!-- jphacks-generated:start -->', end = '<!-- jphacks-generated:end -->';
  const s = oldBody.indexOf(start), e = oldBody.indexOf(end);
  if (s < 0 || e < s) return `${oldBody.trim()}\n\n${generated.replace(marker(id), '').trim()}\n`;
  const gs = generated.indexOf(start), ge = generated.indexOf(end) + end.length;
  return oldBody.slice(0, s) + generated.slice(gs, ge) + oldBody.slice(e + end.length);
}
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
