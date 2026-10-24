import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './lib.mjs';
const roots=['model','ops','docs','prompts','scripts','tests','templates','.claude','.github'];
const fixed=['CLAUDE.md','README.md','START_TKB_2627.html','package.json','.gitignore','.env.example','.env.ai-local.example'];
const excludes=new Set(['ops/team.json']);
function walk(dir){return fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);}
const files=[...fixed,...roots.flatMap(walk)].filter(n=>!excludes.has(n)&&!n.includes('__pycache__')&&!n.endsWith('.pyc'));
let body=fs.readFileSync(path.join(ROOT,'prompts/MASTER_HEADER.txt'),'utf8');
for(const name of files.sort()){
 const content=fs.readFileSync(path.join(ROOT,name),'utf8');
 const runs=[...content.matchAll(/`+/g)].map(x=>x[0].length);
 const fence='`'.repeat(Math.max(4,1,...runs)+1);
 const lang=name.endsWith('.json')?'json':name.endsWith('.mjs')?'javascript':name.endsWith('.py')?'python':name.endsWith('.html')?'html':name.endsWith('.yml')?'yaml':'text';
 body+='\n\n## 保存先：'+name+'\n\n'+fence+lang+'\n'+content.trimEnd()+'\n'+fence+'\n';
}
fs.writeFileSync(path.join(ROOT,'AI_MASTER_PROMPT.txt'),body);
console.log('AI_MASTER_PROMPT.txt: '+files.length+' files embedded; '+Buffer.byteLength(body)+' bytes.');
