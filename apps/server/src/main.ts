import { buildApp } from './platform/app.ts';
import { loadConfig, loadEnvFile } from './platform/config.ts';

loadEnvFile();
const config = loadConfig();
const app = buildApp({ config });
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await app.listen({ host: config.bind, port: config.port });
console.log(`shared server listening on http://${config.bind}:${config.port}`);
