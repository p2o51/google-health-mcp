/**
 * Exercises the real Worker fetch handler with synthetic Requests — no wrangler,
 * no deployment, no bundler.
 *
 * The protocol layer is a verbatim copy of the getnote-video-mcp and lyrics-mcp
 * ones, so these assertions intentionally mirror theirs: if any of the three
 * drift, one of the suites should start failing.
 *
 * Data logic lives in health.test.ts. Nothing here touches the real Google API —
 * the upstream URLs are pinned at a closed port so an accidental network call
 * fails loudly instead of quietly reading real health data.
 *
 *   node test/protocol.test.ts
 */

import { McpServer } from '../src/mcp.ts';
import { buildTools, SERVER_INSTRUCTIONS } from '../src/tools.ts';

const TOKEN = 'test-token-abc123';

type EnvOverrides = Record<string, string | undefined>;

const baseEnv = {
  MCP_SHARED_TOKEN: TOKEN,
  DEBUG_TOOLS: '0',
  LOG_REQUESTS: '0',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REFRESH_TOKEN: 'test-refresh',
  // Upstreams pinned at a closed port. This server reads personal health data,
  // so a protocol test must never be able to reach Google by accident.
  GOOGLE_TOKEN_URL: 'http://127.0.0.1:1/token',
  GOOGLE_API_BASE: 'http://127.0.0.1:1',
};

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)?.slice(0, 400)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function call(
  body: unknown,
  opts: { token?: string | null; path?: string; method?: string; headers?: Record<string, string>; env?: EnvOverrides } = {},
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const path = opts.path ?? '/mcp';
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const req = new Request(`https://example.com${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

  const env: EnvOverrides = { ...baseEnv, ...(opts.env ?? {}) };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];

  const res = await new McpServer({ name: 'google-health', version: '2.0.0-oauth', instructions: SERVER_INSTRUCTIONS, tools: buildTools(env as never) }).handle(req, env as never);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body is expected for some routes */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const rpc = (method: string, params?: unknown, id: string | number = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

async function toolCall(name: string, args: Record<string, unknown>, env?: EnvOverrides) {
  const r = await call(rpc('tools/call', { name, arguments: args }, 7), { env });
  return { ...r, result: r.json?.result, content: r.json?.result?.content?.[0]?.text as string | undefined };
}

// Worker routing/auth is exercised by oauth.oauth.test.ts.

section('Handshake');
{
  const r = await call(rpc('initialize', { protocolVersion: '2025-11-25' }));
  const res = r.json?.result;
  check('initialize → 200', r.status === 200, r.status);
  check('echoes the requested protocol version', res?.protocolVersion === '2025-11-25', res?.protocolVersion);
  check('capabilities is exactly {tools:{}}', JSON.stringify(res?.capabilities) === '{"tools":{}}', res?.capabilities);
  check('serverInfo names this server', res?.serverInfo?.name === 'google-health', res?.serverInfo);
  check('sends instructions', typeof res?.instructions === 'string' && res.instructions.length > 50);
  check('instructions name the summary tool first', /get_health_summary/.test(res?.instructions ?? ''));
  check('instructions state dates are local', /LOCAL calendar dates/.test(res?.instructions ?? ''));
  check('instructions explain the sleep end-date rule', /filed under the date it ENDED/.test(res?.instructions ?? ''));
  check('instructions clarify the span cap is a width limit', /how far back/.test(res?.instructions ?? ''));
  check('mints no session id', r.headers.get('Mcp-Session-Id') === null);
}
{
  const r = await call(rpc('initialize', { protocolVersion: '1999-01-01' }));
  check('unknown version → answers with latest, not an error', r.json?.result?.protocolVersion === '2026-07-28' && !r.json?.error, r.json);
}
{
  const r = await call(rpc('initialize'), { headers: { 'MCP-Protocol-Version': '2001-01-01' } });
  check('unknown MCP-Protocol-Version header → 400', r.status === 400, r.status);
}
{
  const r = await call(rpc('initialize'));
  check('absent MCP-Protocol-Version header is fine', r.status === 200, r.status);
}
{
  const r = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('notifications/initialized → 202 empty', r.status === 202 && r.text === '', { status: r.status, text: r.text });
}
{
  const r = await call(rpc('ping', undefined, 'str-id'));
  check('ping → empty result', JSON.stringify(r.json?.result) === '{}', r.json);
  check('preserves a string id', r.json?.id === 'str-id', r.json?.id);
}
{
  const r = await call(rpc('server/discover'));
  check('server/discover works (forward-compat)', r.json?.result?.resultType === 'complete' && Array.isArray(r.json?.result?.supportedVersions), r.json);
}

section('Protocol errors');
{
  const r = await call('{not json');
  check('malformed JSON → 400 parse error', r.status === 400 && r.json?.error?.code === -32700, r.json);
}
{
  const r = await call([rpc('ping'), rpc('ping')]);
  check('batched array → 400', r.status === 400 && r.json?.error?.code === -32600, r.json);
}
{
  const r = await call(rpc('no/such/method'));
  check('unknown method → -32601', r.json?.error?.code === -32601, r.json);
}
{
  const r = await call(rpc('tools/call', { name: 'nope', arguments: {} }));
  check('unknown tool → -32602 listing the tools', r.json?.error?.code === -32602 && /Available:/.test(r.json.error.message), r.json);
}

section('tools/list');
{
  const r = await call(rpc('tools/list'));
  const tools: any[] = r.json?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check('exposes exactly the 15 read-only health tools', names.length === 15, names);
  for (const n of ['get_health_summary','get_steps_by_day','get_sleep','get_workouts','get_body_metrics','list_health_data_types','query_health_data','aggregate_health_data']) {
    check(`${n} present`, names.includes(n), names);
  }
  check('health_diagnostics hidden by default', !names.includes('health_diagnostics'), names);
  check('every tool is read-only — this server never writes', tools.every((t) => t.annotations?.readOnlyHint === true), tools.map((t) => [t.name, t.annotations]));

  for (const t of tools) {
    const s = t.inputSchema ?? {};
    const props = Object.keys(s.properties ?? {});
    const req: string[] = s.required ?? [];
    check(`${t.name}: schema is a closed object`, s.type === 'object' && s.additionalProperties === false, s);
    check(`${t.name}: every property is listed in required`, props.every((p) => req.includes(p)), { props, req });
    check(`${t.name}: description is substantive`, typeof t.description === 'string' && t.description.length > 80);
    check(`${t.name}: no $ref/oneOf/anyOf/allOf/$defs/format`, !/(\$ref|oneOf|anyOf|allOf|\$defs|"format")/.test(JSON.stringify(s)));
    check(`${t.name}: name uses safe characters`, /^[A-Za-z0-9_.-]+$/.test(t.name), t.name);
    check(`${t.name}: is marked read-only`, t.annotations?.readOnlyHint === true, t.annotations);
  }
  const steps = tools.find((t) => t.name === 'get_steps_by_day');
  check('get_steps_by_day documents the 90-day cap', /90/.test(steps?.description ?? ''), steps?.description?.slice(0, 200));
  check('get_steps_by_day says the cap is on width, not recency', /WIDTH|how far back/.test(steps?.description ?? ''));
  const sleep = tools.find((t) => t.name === 'get_sleep');
  check('get_sleep documents the end-date filing rule', /ENDED/.test(sleep?.description ?? ''));
  const body = tools.find((t) => t.name === 'get_body_metrics');
  check('get_body_metrics directs ranged queries to the flexible tool', /query_health_data/.test(body?.description ?? ''));
}
{
  const r = await call(rpc('tools/list'), { env: { DEBUG_TOOLS: '1' } });
  const names = (r.json?.result?.tools ?? []).map((t: any) => t.name);
  check('DEBUG_TOOLS=1 exposes health_diagnostics', names.includes('health_diagnostics'), names);
}
{
  const r = await call(rpc('resources/list'));
  check('resources/list → empty array, not an error', Array.isArray(r.json?.result?.resources), r.json);
}

section('Tool argument validation (offline — upstream pinned at a closed port)');
{
  const r = await toolCall('get_health_summary', {});
  check('summary without a date → isError', r.result?.isError === true, r.json);
  check('message names the date argument', /date/.test(r.content ?? ''), r.content);
}
{
  const r = await toolCall('get_steps_by_day', { start_date: '24/07/2026', end_date: null });
  check('malformed date → isError', r.result?.isError === true, r.json);
  check('message shows the expected format', /YYYY-MM-DD/.test(r.content ?? ''), r.content);
}
{
  const r = await toolCall('get_steps_by_day', { start_date: '2026-01-01', end_date: '2026-06-01' });
  check('over-wide step range → isError before any network call', r.result?.isError === true, r.json);
  check('message states the 90-day cap', /90/.test(r.content ?? ''), r.content);
}
{
  const r = await toolCall('get_steps_by_day', { start_date: '2026-07-10', end_date: '2026-07-01' });
  check('reversed range → isError', r.result?.isError === true && /before/.test(r.content ?? ''), r.content);
}
{
  const r = await call(rpc('tools/call', { name: 'get_health_summary' }));
  check('tools/call with no arguments object → isError, not a crash', r.json?.result?.isError === true, r.json);
}
{
  const r = await toolCall('get_health_summary', { date: '2026-07-24' }, {
    GOOGLE_REFRESH_TOKEN: undefined,
  });
  check('missing credentials → isError naming the secret', /GOOGLE_REFRESH_TOKEN/.test(r.content ?? ''), r.content);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
