import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {ROOT} from './lib.mjs';
const read=n=>JSON.parse(fs.readFileSync(path.join(ROOT,n),'utf8'));
export function validateModel(system,contracts,flows,data,code){
 const errors=[],nodes=new Map(system.nodes.map(n=>[n.id,n])),rels=new Map(system.relations.map(r=>[r.id,r])),ks=new Set(contracts.map(k=>k.id));
 if(nodes.size!==system.nodes.length)errors.push('duplicate node');if(rels.size!==system.relations.length)errors.push('duplicate relationship');if(ks.size!==contracts.length)errors.push('duplicate contract');
 for(const n of system.nodes){if(!n.role||!n.kind)errors.push('missing responsibility '+n.id);if(n.parent&&!nodes.has(n.parent))errors.push('missing parent '+n.id);}
 for(const r of system.relations){if(!nodes.has(r.source)||!nodes.has(r.target))errors.push('unknown endpoint '+r.id);for(const k of ['send','receive','protocol'])if(!r[k])errors.push('missing '+k+' '+r.id);if(!ks.has(r.contract))errors.push('unknown contract '+r.id);}
 for(const v of system.views){if(v.nodes.some(n=>!nodes.has(n)))errors.push('view unknown node '+v.id);for(const id of v.relations){const r=rels.get(id);if(!r||!v.nodes.includes(r.source)||!v.nodes.includes(r.target))errors.push('view invalid relationship '+v.id+' '+id);}}
 for(const f of flows){for(const [i,s] of f.steps.entries()){if(s.number!==i+1)errors.push('nonsequential step '+f.id);if(!ks.has(s.contract))errors.push('unknown step contract '+f.id);if(s.direction==='self'){if(!f.actors.includes(s.actor))errors.push('unknown self actor '+f.id);continue;}const r=rels.get(s.relation);if(!r||!f.actors.includes(r.source)||!f.actors.includes(r.target))errors.push('dynamic relation not in static model '+f.id);if(!['request','response'].includes(s.direction))errors.push('invalid direction '+f.id);}}
 const ts=new Set(data.tables.map(t=>t.id));for(const l of data.links)if(!ts.has(l.source)||!ts.has(l.target)||!l.field||!l.fromCard||!l.toCard)errors.push('invalid data relationship');
 const cs=new Set(code.types.map(t=>t.id));for(const l of code.links)if(!cs.has(l.source)||!cs.has(l.target)||!l.label)errors.push('invalid code relationship');
 return errors;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.join(ROOT,'scripts/check-model.mjs')){
 const errors=validateModel(read('model/system.json'),read('model/contracts.json'),read('model/workflows.json'),read('model/data-model.json'),read('model/code-model.json'));
 const h=crypto.createHash('sha256');for(const n of ['system','contracts','workflows','data-model','code-model'])h.update(fs.readFileSync(path.join(ROOT,'model',n+'.json')));
 const stamp=path.join(ROOT,'assets/model.sha256');if(!fs.existsSync(stamp)||fs.readFileSync(stamp,'utf8').trim()!==h.digest('hex'))errors.push('stale diagram assets');
 if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log('C4 nodes, directions, contracts, dynamic references, data relationships and diagram source hash: PASS');
}
