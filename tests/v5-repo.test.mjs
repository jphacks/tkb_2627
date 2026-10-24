import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {ROOT} from '../scripts/lib.mjs';
const rd=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
test('tkb_2627 is fixed in prompts and start guide',()=>{
 for(const p of ['CLAUDE.md','prompts/MASTER_HEADER.txt','prompts/M1_START.txt','prompts/M2_START.txt','prompts/M3_START.txt','prompts/M4_START.txt','README.md'])assert.match(rd(p),/tkb_2627/,p);
});
test('all six expected subagent definitions have models',()=>{
 for(const [name,model] of Object.entries({'architect':'inherit','implementer':'sonnet','ui-builder':'sonnet','test-author':'sonnet','reviewer':'inherit','doc-checker':'haiku'})){
 const s=rd('.claude/agents/'+name+'.md');assert.match(s,new RegExp('name: '+name));assert.match(s,new RegExp('model: '+model));
 }
});
test('runbook never asks participant to clone a separate repo',()=>{
 const runbook=JSON.parse(rd('ops/runbook.json'));for(const r of runbook){assert.ok(!r.commands.some(c=>/gh repo clone|git clone|travel-project/.test(c)),r.id);}
});
test('safe placement rejects a Git repo named differently',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'tkb-verify-'));
 try {const dir=path.join(base,'wrong-repo');fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'remote','add','origin','https://github.com/example/wrong-repo.git']);
  const out=spawnSync(process.execPath,[path.join(ROOT,'scripts/place-kit.mjs'),'--target',dir,'--expect-repo','tkb_2627','--apply'],{encoding:'utf8'});assert.notEqual(out.status,0);assert.deepEqual(fs.readdirSync(dir),['.git']);
 }finally{fs.rmSync(base,{recursive:true,force:true})}
});
test('safe placement dry-run accepts checked-out tkb_2627 repo without writing',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'tkb-verify-'));
 try {const dir=path.join(base,'tkb_2627');fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'remote','add','origin','git@github.com:example/tkb_2627.git']);
  const out=spawnSync(process.execPath,[path.join(ROOT,'scripts/place-kit.mjs'),'--target',dir,'--expect-repo','tkb_2627'],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);assert.deepEqual(fs.readdirSync(dir),['.git']);
 }finally{fs.rmSync(base,{recursive:true,force:true})}
});

test('explicit skip-conflicts protects pre-existing README while installing missing kit files',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'tkb-install-'));
 try {
  const dir=path.join(base,'tkb_2627');fs.mkdirSync(dir);execFileSync('git',['init','-q',dir]);execFileSync('git',['-C',dir,'remote','add','origin','https://github.com/example/tkb_2627.git']);
  fs.writeFileSync(path.join(dir,'README.md'),'KEEP EXISTING');
  const out=spawnSync(process.execPath,[path.join(ROOT,'scripts/place-kit.mjs'),'--target',dir,'--expect-repo','tkb_2627','--apply','--skip-conflicts'],{encoding:'utf8'});
  assert.equal(out.status,0,out.stderr);
  assert.equal(fs.readFileSync(path.join(dir,'README.md'),'utf8'),'KEEP EXISTING');
  assert.ok(fs.existsSync(path.join(dir,'CLAUDE.md')));
  assert.ok(out.stdout.includes('SKIPPED'));
 }finally{fs.rmSync(base,{recursive:true,force:true})}
});
