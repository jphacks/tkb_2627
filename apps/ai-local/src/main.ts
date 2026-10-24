import { buildApp } from './app.ts';
import { PairingStore } from './auth/pairing.ts';
import { loadConfig, loadEnvFile } from './config.ts';

loadEnvFile();
const config = loadConfig();
const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
const app = buildApp({ config, pairing });
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await app.listen({ host: config.bind, port: config.port });
console.log(`personal app server listening on http://${config.bind}:${config.port}`);
// The pairing code is shown only here (terminal), never over HTTP.
console.log(`pairing code (single use, ${config.pairingTtlMs / 60000} min): ${pairing.issue()}`);
if (config.ownerUserId === null) console.warn('PERSONAL_OWNER_USER_ID is empty: every login will be rejected.');
