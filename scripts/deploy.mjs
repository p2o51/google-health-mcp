import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const index = args.indexOf('--config');
const path = index >= 0 ? args[index + 1] : process.env.HEALTH_MCP_CONFIG || 'wrangler.jsonc';
const fail = message => { console.error(message); process.exit(1); };
if (!path || path.startsWith('--')) fail('--config requires a filename.');
// The template deliberately uses JSON-compatible JSONC for dependency-free validation.
let config;
try { config = JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { fail('Cannot read configuration as JSON.'); }
const prod = config.env?.production;
const vars = prod?.vars || {};
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vars.OWNER_EMAIL || '') || vars.OWNER_EMAIL.endsWith('@example.com')) fail('Set OWNER_EMAIL to your exact owner account.');
if (!/^[a-f0-9]{64}$/.test(vars.ACCESS_AUD || '')) fail('Configure the dedicated Cloudflare Access application audience.');
if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(vars.ACCESS_TEAM_DOMAIN || '') || vars.ACCESS_TEAM_DOMAIN.startsWith('your-team.')) fail('Configure your Access team domain.');
let origin;
try { origin = new URL(vars.PUBLIC_BASE_URL); } catch { fail('PUBLIC_BASE_URL must be an HTTPS origin.'); }
if (origin.protocol !== 'https:' || origin.origin !== vars.PUBLIC_BASE_URL || origin.hostname.endsWith('.example.com')) fail('PUBLIC_BASE_URL must be your HTTPS origin without a path.');
if (!prod.routes?.some(route => route.custom_domain === true && route.pattern === origin.hostname)) fail('Production custom domain must match PUBLIC_BASE_URL.');
if (vars.LOCAL_DEV_IDENTITY !== '0' || prod.workers_dev !== false || prod.preview_urls !== false) fail('Production identity shortcuts and alternate URLs must remain disabled.');
if (Object.keys(vars).some(key => key.startsWith('TEST_') || key.startsWith('GOOGLE_TEST'))) fail('Remove test hooks from production vars.');
const namespace = prod.kv_namespaces?.find(binding => binding.binding === 'OAUTH_KV')?.id;
if (!/^[a-f0-9]{32}$/.test(namespace || '') || /^0+$/.test(namespace)) fail('Configure a dedicated production OAuth KV namespace.');
if (args.includes('--check')) { console.log('Production configuration checks passed.'); process.exit(0); }
// Do not accept arbitrary flags that could override the validated environment or identity.
const allowed = index >= 0 ? ['--config', path] : [];
if (args.some((arg, i) => arg !== allowed[i]) || args.length !== allowed.length) fail('Supported options: --config <file>, --check.');
const result = spawnSync('npx', ['wrangler', 'deploy', '--env', 'production', '--config', path], { stdio: 'inherit' });
process.exit(result.status ?? 1);
