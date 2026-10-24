import os from 'node:os';
import { spawnSync } from 'node:child_process';
const commands = [ ['git', ['--version']], ['gh', ['--version']], ['claude', ['--version']], ['cloudflared', ['--version']] ];
console.log(JSON.stringify({ node: process.version, appTargetNodeMajor: 24, kitMinimumNodeMajor: 22,
  platform: process.platform, architecture: process.arch,
  totalRamGiB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10,
  note: 'Command presence does not certify Claude authentication or permitted application use. No credentials are displayed.' }, null, 2));
for (const [cmd, args] of commands) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, shell: false });
  const output = (r.stdout || r.stderr || '').trim().split('\n')[0].slice(0, 180);
  console.log(`${cmd}: ${r.status === 0 ? output : 'not ready / not installed (manual setup may be needed)'}`);
}
