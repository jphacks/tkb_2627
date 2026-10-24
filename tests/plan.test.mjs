import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, loadInputs, validatePlan, topological, planMetrics, progressFor,
  normalizeRepo, marker, issueIndex, issueState, taskBody, mergeGeneratedBody } from '../scripts/lib.mjs';

const { plan, requirements } = loadInputs();
const clone = x => structuredClone(x);
const tiny = () => ({ owners: ['M1'], tasks: ['B01','B02'].map((id,i) => ({
  id, title:id, owner:'M1', dependsOn:i ? ['B01'] : [], requirements:['R01'],
  uiDependency:'none', writePaths:['apps/test'], initialStatus:'todo', acceptance:'accepted', verification:'tested',
  estimateMinutes:{low:10, high:20}
})) });
const req = [{id:'R01', title:'Example'}];

test('real plan has 54 tasks, 30 requirements and validates', () => {
  assert.equal(plan.tasks.length,54); assert.equal(requirements.length,30);
  assert.deepEqual(validatePlan(plan, requirements), []);
});
test('all dependencies precede children in topological order', () => {
  const ordered = topological(plan.tasks).map(t=>t.id);
  for (const t of plan.tasks) for (const d of t.dependsOn) assert.ok(ordered.indexOf(d)<ordered.indexOf(t.id));
});
test('all requirements have an implementation task, not only the final acceptance task', () => {
  for (const r of requirements) assert.ok(plan.tasks.some(t=>t.requirements.includes(r.id) && !/^[TZ]/.test(t.id)), r.id);
});
test('no application task is falsely marked complete', () => {
  assert.ok(plan.tasks.every(t=>t.initialStatus==='todo'));
  assert.equal(progressFor(plan).tasks.filter(t=>t.status==='done').length,0);
});
test('cycle rejected', () => { const p=tiny(); p.tasks[0].dependsOn=['B02']; assert.match(validatePlan(p,req).join(),/Cycle/); });
test('missing dependency rejected', () => { const p=tiny(); p.tasks[1].dependsOn=['X99']; assert.match(validatePlan(p,req).join(),/Invalid dependency/); });
test('duplicate task rejected', () => { const p=tiny(); p.tasks.push(clone(p.tasks[0])); assert.match(validatePlan(p,req).join(),/duplicate task/); });
test('self dependency rejected', () => { const p=tiny(); p.tasks[1].dependsOn=['B02']; assert.match(validatePlan(p,req).join(),/Invalid dependency/); });
test('unknown owner rejected', () => { const p=tiny(); p.tasks[0].owner='M9'; assert.match(validatePlan(p,req).join(),/Invalid owner/); });
test('uncovered requirement rejected', () => { assert.match(validatePlan(tiny(), [...req,{id:'R02'}]).join(),/Uncovered requirement/); });
test('unknown requirement rejected', () => { const p=tiny(); p.tasks[0].requirements.push('R99'); assert.match(validatePlan(p,req).join(),/Unknown requirement/); });
test('unsafe relative write path rejected', () => { const p=tiny(); p.tasks[0].writePaths=['../secret']; assert.match(validatePlan(p,req).join(),/Invalid write paths/); });
test('missing acceptance rejected', () => { const p=tiny(); p.tasks[0].acceptance=''; assert.match(validatePlan(p,req).join(),/Missing acceptance/); });
test('invalid UI dependency rejected', () => { const p=tiny(); p.tasks[0].uiDependency='magic'; assert.match(validatePlan(p,req).join(),/Invalid UI dependency/); });
test('estimates and levels are deterministic', () => {
  const m=planMetrics(tiny()); assert.equal(m.levels.B02,1);
  assert.equal(m.resourceUnconstrainedMinPathMinutes,20); assert.deepEqual(m.laneMinutes.M1,{low:20,high:40});
});
test('UI prototype does not depend on real model or travel API', () => {
  const byId=new Map(plan.tasks.map(t=>[t.id,t])), ancestors=new Set();
  const visit=id=>{ for(const d of byId.get(id).dependsOn) if(!ancestors.has(d)){ancestors.add(d);visit(d);} }; visit('U01');
  assert.ok(![...ancestors].some(id=>/^A|^D/.test(id)));
});
test('backend tasks are not gated on the UI approval milestone', () => {
  const byId=new Map(plan.tasks.map(t=>[t.id,t]));
  function hasUI(id){ return byId.get(id).dependsOn.some(d=>d==='U02'||hasUI(d)); }
  for(const id of ['D03','D04','S02','A02','A03','A04']) assert.equal(hasUI(id),false,id);
});
test('initial ready queue contains B01 only', () => { assert.deepEqual(progressFor(plan).tasks.filter(t=>t.displayStatus==='ready').map(t=>t.id),['B01']); });
test('completed predecessor unlocks next task', () => {
  const p=progressFor(tiny(),{tasks:{B01:{status:'done'}}});
  assert.equal(p.tasks[1].displayStatus,'ready');
});
test('done with incomplete dependencies warns', () => { assert.equal(progressFor(tiny(),{tasks:{B02:{status:'done'}}}).warnings.length,1); });
test('unknown snapshot status does not invent completion', () => { assert.equal(progressFor(tiny(),{tasks:{B01:{status:'finished'}}}).tasks[0].status,'todo'); });
test('repository URL forms normalize', () => {
  for (const input of ['alice/travel','https://github.com/alice/travel','https://github.com/alice/travel.git','git@github.com:alice/travel.git']) assert.equal(normalizeRepo(input),'alice/travel');
});
test('placeholder and credentialed or non GitHub URLs rejected', () => {
  for(const s of ['OWNER/REPO','https://token@github.com/a/b','https://evil.test/a/b','a/b/c','']) assert.throws(()=>normalizeRepo(s));
});
test('issue identity uses markers, never title alone', () => {
  const index=issueIndex([{number:1,body:marker('B01'),title:'renamed'},{number:2,title:'[B02] Fake',body:'unrelated'}]);
  assert.equal(index.get('B01').number,1); assert.equal(index.has('B02'),false);
});
test('duplicate issue markers are rejected', () => { assert.throws(()=>issueIndex([{number:1,body:marker('B01')},{number:2,body:marker('B01')}]),/Duplicate/); });
test('multiple task markers in one issue are rejected', () => { assert.throws(()=>issueIndex([{number:1,body:marker('B01')+marker('B02')}]),/Multiple/); });
test('closed issue without explicit done is not considered complete', () => { assert.equal(issueState({state:'CLOSED',labels:[]}).status,'review'); });
test('open issue with done label remains in review', () => { assert.equal(issueState({state:'OPEN',labels:['status:done']}).status,'review'); });
test('explicit reviewed completion may be imported', () => { assert.equal(issueState({state:'CLOSED',labels:['status:done']}).status,'done'); });
test('conflicting status labels are blocked', () => { assert.equal(issueState({state:'OPEN',labels:['status:doing','status:todo']}).status,'blocked'); });
test('updating generated body preserves manual evidence', () => {
  const t=tiny().tasks[0], old=taskBody(t)+'\nHuman evidence: checked.\n';
  const updated=mergeGeneratedBody(old,taskBody({...t,title:'updated'}),t.id);
  assert.ok(updated.includes('Human evidence: checked.')); assert.ok(updated.includes('updated'));
  assert.equal([...updated.matchAll(/jphacks-task:B01/g)].length,1);
});
test('unchanged generated section is idempotent', () => {
  const t=tiny().tasks[0], body=taskBody(t); assert.equal(mergeGeneratedBody(body,body,t.id),body);
});
test('plan-only GitHub initialization does not require network or credentials', () => {
  const r=spawnSync(process.execPath,['scripts/github-sync.mjs','init','--repo','example/travel'],{cwd:ROOT,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr); const data=JSON.parse(r.stdout);
  assert.equal(data.mode,'PLAN_ONLY_NO_NETWORK'); assert.equal(data.tasks.length,54);
});
test('six agent files are supplied with role headers', () => {
  const names=fs.readdirSync(path.join(ROOT,'.claude/agents')).filter(n=>n.endsWith('.md'));
  assert.equal(names.length,6); for(const n of names){const s=fs.readFileSync(path.join(ROOT,'.claude/agents',n),'utf8');assert.match(s,/^---\nname:/); assert.match(s,/\nmodel: /);}
});
test('dashboard builds standalone HTML and includes all tasks', () => {
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'tkb-dash-'));
  const r=spawnSync(process.execPath,['scripts/render-dashboard.mjs','--out',out],{cwd:ROOT,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr); const html=fs.readFileSync(path.join(out,'dashboard/index.html'),'utf8');
  fs.rmSync(out,{recursive:true,force:true});
  assert.ok(!html.includes('__DATA__')); assert.ok(!/<script[^>]+src=/i.test(html));
  const raw=html.match(/<script type="application\/json" id="design-data">([\s\S]*?)<\/script>/)?.[1];
  assert.equal(JSON.parse(raw).tasks.length,54);
});
test('local GitHub snapshot goes only into the git-ignored dashboard, never tracked HTML', () => {
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'tkb-dash-'));
  const snap=path.join(out,'snap.json');
  fs.writeFileSync(snap,JSON.stringify({repository:'x/y',fetchedAt:'2026-01-01T00:00:00Z',warnings:['$& $$ $\''],tasks:{}}));
  const r=spawnSync(process.execPath,['scripts/render-dashboard.mjs','--out',out,'--snapshot',snap],{cwd:ROOT,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
  const data=f=>JSON.parse(fs.readFileSync(path.join(out,f),'utf8').match(/<script type="application\/json" id="design-data">([\s\S]*?)<\/script>/)[1]);
  try {
    assert.equal(data('SYSTEM_DESIGN.html').snapshot,null);
    assert.equal(data('DEVELOPMENT_GUIDE.html').snapshot,null);
    assert.equal(data('dashboard/index.html').snapshot.fetchedAt,'2026-01-01T00:00:00Z');
  } finally { fs.rmSync(out,{recursive:true,force:true}); }
});
