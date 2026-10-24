import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadInputs } from './lib.mjs';
const oi=process.argv.indexOf('--out');
const OUT=oi>0?path.resolve(process.argv[oi+1]??(()=>{throw new Error('--out requires a directory')})()):ROOT;
const read=n=>JSON.parse(fs.readFileSync(path.join(ROOT,n),'utf8'));
const {plan,requirements}=loadInputs();
const modelFiles=['system','contracts','workflows','data-model','code-model'];
const hash=crypto.createHash('sha256');for(const n of modelFiles)hash.update(fs.readFileSync(path.join(ROOT,'model',n+'.json')));
const modelHash=hash.digest('hex');
const stamp=path.join(ROOT,'assets/model.sha256');
if(!fs.existsSync(stamp)||fs.readFileSync(stamp,'utf8').trim()!==modelHash)throw new Error('Diagram sources changed. Run python3 scripts/build-figures.py before npm run guide.');
const figures=Object.fromEntries(fs.readdirSync(path.join(ROOT,'assets')).filter(n=>n.endsWith('.svg')).map(n=>[n.slice(0,-4),fs.readFileSync(path.join(ROOT,'assets',n),'utf8')]));
const si=process.argv.indexOf('--snapshot');
const snapFile=si>0?path.resolve(process.argv[si+1]??''):path.join(ROOT,'.local/github-snapshot.json');
const data={version:'5.0',modelHash,system:read('model/system.json'),contracts:read('model/contracts.json'),flows:read('model/workflows.json'),dataModel:read('model/data-model.json'),codeModel:read('model/code-model.json'),visibility:read('model/visibility.json'),sources:read('model/sources.json'),tasks:plan.tasks,requirements,runbook:read('ops/runbook.json'),management:read('ops/information-management.json'),roles:read('ops/team-roles.json'),collaboration:read('ops/collaboration-cases.json'),snapshot:null,figures};
// Tracked HTML never embeds the local GitHub snapshot (it would dirty every checkout);
// only the git-ignored dashboard/index.html shows it.
const snapshot=fs.existsSync(snapFile)?JSON.parse(fs.readFileSync(snapFile,'utf8')):null;
const encode=d=>JSON.stringify(d).replace(/</g,'\\u003c');
const raw=encode(data);
const rawWithSnapshot=encode({...data,snapshot});
const template=fs.readFileSync(path.join(ROOT,'templates/guide.html'),'utf8');
for(const [mode,file,title] of [['system','SYSTEM_DESIGN.html','JPHacks | C4システム設計 v5'],['development','DEVELOPMENT_GUIDE.html','JPHacks | 4人の開発手順 v5']]){
 const html=template.replace('__TITLE__',title).replaceAll('__MODE__',mode).replace('__DATA__',()=>raw);
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,file),html);
 if(mode==='development'){fs.mkdirSync(path.join(OUT,'dashboard'),{recursive:true});fs.writeFileSync(path.join(OUT,'dashboard/index.html'),html.replace(raw,()=>rawWithSnapshot));}
 console.log(file+' built from model '+modelHash.slice(0,12));
}
