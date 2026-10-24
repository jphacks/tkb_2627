import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { PairingStore } from './auth/pairing.ts';
import { loadConfig, loadEnvFile } from './config.ts';
import { metricsLine } from './generation/metrics.ts';

loadEnvFile();
const config = loadConfig();
config.jobDir ??= fileURLToPath(new URL('../../../.local/ai-local/', import.meta.url));
const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
// Content-free job metrics, only when asked for.
const onMetrics = process.env.AI_LOG_METRICS === 'true' ? (m: Parameters<typeof metricsLine>[0]) => console.log(metricsLine(m)) : undefined;
const app = buildApp({ config, pairing, onMetrics });
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await app.listen({ host: config.bind, port: config.port });
console.log(`personal app server listening on http://${config.bind}:${config.port}`);
// The pairing code is shown only here (terminal), never over HTTP.
console.log(`pairing code (single use, ${config.pairingTtlMs / 60000} min): ${pairing.issue()}`);
if (config.ownerUserId === null) console.warn('PERSONAL_OWNER_USER_ID is empty: every login will be rejected.');
