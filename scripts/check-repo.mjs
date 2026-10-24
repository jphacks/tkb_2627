import path from 'node:path';
import {execFileSync} from 'node:child_process';
const expected='tkb_2627';
function git(...args){return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}
try {
 const root=git('rev-parse','--show-toplevel');
 const remote=git('remote','get-url','origin');
 const repoName=remote.replace(/\.git$/,'').replace(/\/$/,'').split(/[\/:]/).pop();
 const expectedFolder=path.basename(root)===expected;
 const expectedRemote=repoName===expected;
 console.log(JSON.stringify({gitRoot:root,repoName,origin:remote,folderMatches:expectedFolder,remoteMatches:expectedRemote,branch:git('branch','--show-current'),status:git('status','--short')},null,2));
 if(!expectedFolder||!expectedRemote){console.error('Expected existing Git checkout tkb_2627. No changes made.');process.exitCode=1;}
} catch (e) {console.error('Not inside a configured Git repository with origin: '+e.message);process.exitCode=1;}
