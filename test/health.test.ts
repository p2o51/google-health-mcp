/**
 * Data logic against a mock Google (token endpoint + Health API): timezone
 * handling, server rollups, span caps, string coercion, and — importantly — that
 * the outgoing filter expression uses the right field for each data type.
 *
 * Fixtures are synthetic. No real health data appears in this file.
 *
 *   node test/health.test.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '../src/mcp.ts';
import { buildTools, SERVER_INSTRUCTIONS } from '../src/tools.ts';
import { civilDate, durationSeconds, localDate, num } from '../src/google.ts';

const TOKEN = 'tok';

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
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  }
}

// ── pure units ───────────────────────────────────────────────────────────────

console.log('Value coercion (every API number is a string)');
check('num parses an int64-as-string', num('12345') === 12345);
check('num passes numbers through', num(7) === 7);
check('num rejects empty and junk', num('') === undefined && num('abc') === undefined && num(null) === undefined);
check('durationSeconds parses "32400s"', durationSeconds('32400s') === 32400);
check('durationSeconds parses fractional "1161.600s"', durationSeconds('1161.600s') === 1161.6);
check('durationSeconds handles a bare number string', durationSeconds('600') === 600);

console.log('\nCivil date rendering');
check(
  'zero-pads month and day',
  civilDate({ date: { year: '2026', month: '7', day: '4' } }) === '2026-07-04',
  civilDate({ date: { year: '2026', month: '7', day: '4' } }),
);
check('missing parts → undefined', civilDate({ date: { year: '2026' } }) === undefined);
check('undefined input → undefined', civilDate(undefined) === undefined);

console.log('\nTimezone — the case that misfiles sleep');
{
  // A real session from the live API: 16:54Z with a +9h offset is 01:54 the NEXT
  // day locally. Grouping on the UTC date would file this night one day early.
  const utc = '2026-07-24T16:54:00Z';
  check('UTC date and local date genuinely differ here', utc.slice(0, 10) === '2026-07-24');
  check('local date shifts to the 25th with +32400s', localDate(utc, '32400s') === '2026-07-25', localDate(utc, '32400s'));
  check('no offset → UTC date', localDate(utc, undefined) === '2026-07-24');
  check('negative offset shifts backwards', localDate('2026-07-25T02:00:00Z', '-18000s') === '2026-07-24');
  check('invalid timestamp → undefined', localDate('not-a-date', '0s') === undefined);
}

// ── mock upstream ────────────────────────────────────────────────────────────

interface Recorded {
  path: string;
  action?: string;
  method: string;
  body: Record<string, unknown>;
  filter?: string;
  pageToken?: string;
  pageSize?: string;
}

type Fixtures = Partial<Record<string, unknown[]>>;

let recorded: Recorded[] = [];
let tokenCalls = 0;

/** Serves both the OAuth token endpoint and the dataPoints API. */
async function withMock<T>(
  fixtures: Fixtures,
  fn: (env: Record<string, string>) => Promise<T>,
  opts: { tokenError?: string; apiError?: { status: number; body: unknown }; typeErrors?: Record<string, { status: number; body: unknown }>; paginate?: boolean } = {},
): Promise<T> {
  recorded = [];
  tokenCalls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/token') {
      tokenCalls++;
      // Drain the body so the client's POST completes cleanly.
      req.on('data', () => {});
      req.on('end', () => {
        if (opts.tokenError) return send(400, { error: opts.tokenError });
        send(200, { access_token: 'ya29.mock', expires_in: 3599, token_type: 'Bearer' });
      });
      return;
    }

    const m = /^\/users\/me\/dataTypes\/([^/]+)\/dataPoints(?::(dailyRollUp|rollUp|reconcile))?$/.exec(url.pathname);
    if (!m?.[1]) return send(404, '<!DOCTYPE html><html>not found</html>');
    const type = m[1];
    const action = m[2];
    let text = '';
    req.on('data', (part) => { text += part; });
    req.on('end', () => {
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      recorded.push({
        path: type,
        action,
        method: req.method ?? 'GET',
        body,
        filter: url.searchParams.get('filter') ?? undefined,
        pageToken: typeof body.pageToken === 'string' ? body.pageToken : url.searchParams.get('pageToken') ?? undefined,
        pageSize: body.pageSize !== undefined ? String(body.pageSize) : url.searchParams.get('pageSize') ?? undefined,
      });

      const failure = opts.typeErrors?.[type] ?? opts.apiError;
      if (failure) return send(failure.status, failure.body);

      // Aggregate fixtures are already server-calculated rollupDataPoints. The
      // mock does not reproduce Google's reconciliation or summing algorithm.
      const all = fixtures[type] ?? [];
      const key = action === 'dailyRollUp' || action === 'rollUp' ? 'rollupDataPoints' : 'dataPoints';
      if (opts.paginate && all.length > 1) {
        const idx = Number(body.pageToken ?? url.searchParams.get('pageToken') ?? '0');
        const item = all[idx];
        const next = idx + 1 < all.length ? String(idx + 1) : undefined;
        return send(200, { [key]: item ? [item] : [], ...(next ? { nextPageToken: next } : {}) });
      }
      send(200, { [key]: all });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_REFRESH_TOKEN: 'refresh',
      MCP_SHARED_TOKEN: TOKEN,
      GOOGLE_TOKEN_URL: `${base}/token`,
      GOOGLE_API_BASE: base,
      LOG_REQUESTS: '0',
      DEBUG_TOOLS: '1',
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function toolCall(env: Record<string, string>, name: string, args: Record<string, unknown>) {
  const req = new Request('https://example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const res = await new McpServer({ name: 'google-health', version: '2.0.0-oauth', instructions: SERVER_INSTRUCTIONS, tools: buildTools(env as never) }).handle(req, env as never);
  const json: Record<string, never> = JSON.parse(await res.text());
  const result = (json as { result?: Record<string, never> }).result;
  return {
    json,
    isError: (result as { isError?: boolean } | undefined)?.isError === true,
    text: (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text,
    structured: (result as { structuredContent?: Record<string, never> } | undefined)?.structuredContent as
      | Record<string, never>
      | undefined,
  };
}

const stepPoint = (utc: string, offset: string, count: string, civil?: string) => ({
  steps: {
    interval: {
      startTime: utc,
      startUtcOffset: offset,
      endTime: utc,
      endUtcOffset: offset,
      ...(civil
        ? {
            civilStartTime: {
              date: { year: civil.slice(0, 4), month: String(Number(civil.slice(5, 7))), day: String(Number(civil.slice(8, 10))) },
              time: { hours: '12', minutes: '0', seconds: '0' },
            },
          }
        : {}),
    },
    count,
  },
});

const stepRollup = (date: string, count?: string) => ({
  civilStartTime: { date: { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)) } },
  steps: count === undefined ? {} : { countSum: count },
});

// ── filter correctness ───────────────────────────────────────────────────────

console.log('\nOutgoing filter expressions (asymmetric per type — easy to regress)');
await withMock({ steps: [] }, async (env) => {
  await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: '2026-07-25' });
  const request = recorded.find((r) => r.path === 'steps');
  check('steps use POST dailyRollUp instead of enumerating raw fragments', request?.method === 'POST' && request.action === 'dailyRollUp', request);
  const bounds = request?.body.range as { start?: { date?: { day?: number } }; end?: { date?: { day?: number } } } | undefined;
  check('rollup range is [start, inclusive end+1)', bounds?.start?.date?.day === 24 && bounds?.end?.date?.day === 26, bounds);
  check('rollup requests one-day buckets', request?.body.windowSizeDays === 1, request);
  check('rollup pageSize is 100', request?.pageSize === '100', request);
});

await withMock({ sleep: [] }, async (env) => {
  await toolCall(env, 'get_sleep', { start_date: '2026-07-20', end_date: '2026-07-25' });
  const f = recorded.find((r) => r.path === 'sleep')?.filter ?? '';
  // The live API rejects sleep.interval.start_time outright, so this must use END.
  check('sleep filters on civil_END_time, not start', f.includes('sleep.interval.civil_end_time'), f);
  check('sleep does not use start_time', !f.includes('civil_start_time'), f);
  check('sleep session page size respects the official 25 maximum', recorded[0]?.pageSize === '25', recorded[0]);
});

await withMock({ exercise: [] }, async (env) => {
  await toolCall(env, 'get_workouts', { start_date: '2026-07-20', end_date: null });
  const f = recorded.find((r) => r.path === 'exercise')?.filter ?? '';
  check('exercise filters on civil_start_time', f.includes('exercise.interval.civil_start_time'), f);
  check('null end_date collapses to a quoted single-day filter', f.includes('>= "2026-07-20"') && f.includes('< "2026-07-21"'), f);
  check('exercise session page size respects the official 25 maximum', recorded[0]?.pageSize === '25', recorded[0]);
});

await withMock({ weight: [] }, async (env) => {
  await toolCall(env, 'get_body_metrics', { limit: 5 });
  const rec = recorded.find((r) => r.path === 'weight');
  check('recent weight convenience tool makes an unfiltered newest-first read', rec?.filter === undefined, rec);
});

await withMock({ 'daily-resting-heart-rate': [] }, async (env) => {
  await toolCall(env, 'get_health_summary', { date: '2026-07-24' });
  const f = recorded.find((r) => r.path === 'daily-resting-heart-rate')?.filter ?? '';
  // kebab-case in the path, snake_case in the filter.
  check('resting HR filter uses snake_case type name', f.startsWith('daily_resting_heart_rate.date'), f);
  check('path stays kebab-case', recorded.some((r) => r.path === 'daily-resting-heart-rate'), recorded.map((r) => r.path));
});

// ── steps ────────────────────────────────────────────────────────────────────

console.log('\nReconciled daily step rollups');
await withMock(
  { steps: [stepRollup('2026-07-24', '350'), stepRollup('2026-07-25', '7')] },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: '2026-07-25' });
    const days = (r.structured?.days ?? []) as Array<{ date: string; steps: number | null }>;
    check('server rollup dates and values are retained', days[0]?.date === '2026-07-24' && days[0]?.steps === 350 && days[1]?.steps === 7, days);
    check('string countSum is coerced to number', typeof days[0]?.steps === 'number');
    check('total covers both server buckets', r.structured?.total_steps === 357, r.structured);
    check('average counts days with returned values', r.structured?.daily_average === 179, r.structured);
    check('result identifies the Google reconciliation', r.structured?.reconciled === true, r.structured);
  },
);

await withMock(
  { steps: [stepRollup('2026-07-24', '0'), stepRollup('2026-07-25', '10'), stepRollup('2026-07-26')] },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: '2026-07-27' });
    const days = (r.structured?.days ?? []) as Array<{ date: string; steps: number | null }>;
    check('explicit countSum zero remains zero', days[0]?.steps === 0, days);
    check('a returned bucket with no measurement remains null', days[2]?.steps === null, days);
    check('a missing bucket remains null', days[3]?.steps === null, days);
    check('recorded zero contributes to days with data and average', r.structured?.days_with_data === 2 && r.structured?.daily_average === 5, r.structured);
  },
);

await withMock({ steps: [] }, async (env) => {
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-01', end_date: '2026-07-07' });
  const days = (r.structured?.days ?? []) as Array<{ steps: number | null }>;
  check('every requested day remains listed when no buckets are returned', days.length === 7, days.length);
  check('days with no data are null, never zero', days.every(day => day.steps === null), days);
  check('empty range is not an error', !r.isError, r.text);
  check('missing total and average remain null', r.structured?.total_steps === null && r.structured?.daily_average === null, r.structured);
});

await withMock(
  { steps: [stepRollup('2026-07-24', '10'), stepRollup('2026-07-25', '20')] },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: '2026-07-25' });
    check('rollup pagination combines separate daily buckets', r.structured?.total_steps === 30, r.structured);
    check('two rollup pages were fetched', recorded.filter((x) => x.path === 'steps').length === 2, recorded.length);
    check('the second rollup request carries pageToken in its JSON body', recorded[1]?.body.pageToken === '1', recorded);
    check('fully read rollups are not marked truncated', r.structured?.truncated === false, r.structured);
  },
  { paginate: true },
);

console.log('\nPagination caps on unfiltered reads');
await withMock(
  // Ten pages available. An uncapped unfiltered read walks the lot — against the
  // real API that meant 90+ seconds and would have blown the subrequest limit,
  // because weight and the diagnostics cannot filter server-side.
  {
    weight: Array.from({ length: 10 }, (_, i) => ({
      weight: { sampleTime: { civilTime: { date: { year: '2026', month: '7', day: String(i + 1) } } }, weightGrams: String(68000 + i) },
    })),
  },
  async (env) => {
    const r = await toolCall(env, 'get_body_metrics', { limit: 5 });
    const calls = recorded.filter((x) => x.path === 'weight').length;
    check('unfiltered weight read stops after one page', calls === 1, { calls });
    check('still returns data from that page', ((r.structured?.measurements ?? []) as unknown[]).length >= 1, r.structured);
  },
  { paginate: true },
);
await withMock(
  {
    steps: Array.from({ length: 10 }, (_, i) => stepPoint(`2026-07-0${(i % 9) + 1}T01:00:00Z`, '32400s', '10')),
    sleep: [], exercise: [], weight: [], 'daily-resting-heart-rate': [],
  },
  async (env) => {
    await toolCall(env, 'health_diagnostics', {});
    const perType = new Map<string, number>();
    for (const r of recorded) perType.set(r.path, (perType.get(r.path) ?? 0) + 1);
    check(
      'diagnostics probes one page per type, never enumerates',
      [...perType.values()].every((n) => n === 1),
      Object.fromEntries(perType),
    );
  },
  { paginate: true },
);
await withMock(
  { steps: Array.from({ length: 6 }, (_, index) => stepRollup(`2026-07-${String(index + 20).padStart(2, '0')}`, '10')) },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-20', end_date: '2026-07-25' });
    check('convenience step totals stop after three pages', recorded.filter((x) => x.path === 'steps').length === 3, recorded.length);
    check('partial step values are retained', r.structured?.total_steps === 30, r.structured);
    check('remaining rollup pages make truncation explicit', r.structured?.truncated === true && /incomplete/.test(r.text ?? ''), r.structured);
  },
  { paginate: true },
);

// ── span caps and validation ─────────────────────────────────────────────────

console.log('\nSpan caps and date validation');
await withMock({ steps: [] }, async (env) => {
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-01-01', end_date: '2026-04-01' });
  check('a 91-day step range is refused', r.isError, r.text);
  check('the message says at most 90', /90/.test(r.text ?? ''), r.text);
  check('the message clarifies it is a width limit, not recency', /historical window|how wide/i.test(r.text ?? ''), r.text);
  check('no upstream call was made', recorded.length === 0, recorded);
});
await withMock({ steps: [] }, async (env) => {
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-01-01', end_date: '2026-03-31' });
  check('exactly 90 days is allowed', !r.isError, r.text);
});
await withMock({ sleep: [] }, async (env) => {
  const r = await toolCall(env, 'get_sleep', { start_date: '2026-01-01', end_date: '2026-03-01' });
  check('sleep allows a 60-day range (pre-aggregated)', !r.isError, r.text);
});
await withMock({ steps: [] }, async (env) => {
  for (const bad of ['24-07-2026', '2026/07/24', 'yesterday', '2026-13-01', '2026-02-30', '2026-02-29', '2026-04-31']) {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: bad, end_date: null });
    check(`rejects malformed date ${JSON.stringify(bad)}`, r.isError, r.text);
  }
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-25', end_date: '2026-07-20' });
  check('rejects end_date before start_date', r.isError && /before/.test(r.text ?? ''), r.text);
});
await withMock({ steps: [] }, async (env) => {
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2024-02-29', end_date: null });
  check('a real leap day remains accepted', !r.isError, r.text);
});

// ── sleep ────────────────────────────────────────────────────────────────────

console.log('\nSleep');
await withMock(
  {
    sleep: [
      {
        dataSource: { platform: 'FITBIT', device: { displayName: 'Pixel Watch 4' } },
        sleep: {
          interval: {
            startTime: '2026-07-24T16:54:00Z',
            startUtcOffset: '32400s',
            endTime: '2026-07-25T00:43:00Z',
            endUtcOffset: '32400s',
          },
          type: 'STAGES',
          stages: [
            { startTime: '2026-07-24T16:54:00Z', endTime: '2026-07-24T17:24:00Z', type: 'AWAKE' },
            { startTime: '2026-07-24T17:24:00Z', endTime: '2026-07-24T19:24:00Z', type: 'DEEP' },
            { startTime: '2026-07-24T19:24:00Z', endTime: '2026-07-25T00:43:00Z', type: 'LIGHT' },
          ],
          summary: { minutesAsleep: '421', minutesAwake: '30', minutesToFallAsleep: '8', minutesInSleepPeriod: '469', minutesAfterWakeUp: '10' },
          metadata: { stagesStatus: 'SUCCEEDED', processed: true },
        },
      },
    ],
  },
  async (env) => {
    const r = await toolCall(env, 'get_sleep', { start_date: '2026-07-25', end_date: null });
    const nights = (r.structured?.nights ?? []) as Array<Record<string, never>>;
    check('one night returned', nights.length === 1, nights);
    check('filed under the date it ENDED (the 25th)', nights[0]?.date === '2026-07-25', nights[0]);
    check('minutesAsleep coerced from string', nights[0]?.minutes_asleep === 421, nights[0]);
    const stages = (nights[0]?.stage_minutes ?? {}) as Record<string, number>;
    check('stage minutes computed from timestamps', stages.AWAKE === 30 && stages.DEEP === 120, stages);
    check('LIGHT spans midnight UTC correctly', Math.round(stages.LIGHT ?? 0) === 319, stages);
    check('bedtime rendered in local time', nights[0]?.bedtime === '01:54', nights[0]);
    check('wake time rendered in local time', nights[0]?.wake_time === '09:43', nights[0]);
    check('device surfaced in the text', /Pixel Watch 4/.test(r.text ?? ''), r.text?.slice(0, 200));
    check('time in bed and after wake-up are retained', nights[0]?.minutes_in_bed === 469 && nights[0]?.minutes_after_wake_up === 10, nights[0]);
    check('sleep processing state is retained', nights[0]?.stages_status === 'SUCCEEDED' && nights[0]?.processed === true, nights[0]);
    check('sleep device is also available as structured data', nights[0]?.device === 'Pixel Watch 4', nights[0]);
    check('completed sleep read is not marked truncated', r.structured?.truncated === false, r.structured);
  },
);
await withMock({ sleep: [] }, async (env) => {
  const r = await toolCall(env, 'get_sleep', { start_date: '2026-07-25', end_date: null });
  check('no sleep is a normal result, not an error', !r.isError, r.text);
  check('explains the end-date filing rule when empty', /woke up/.test(r.text ?? ''), r.text);
});

// ── workouts ─────────────────────────────────────────────────────────────────

console.log('\nWorkouts');
await withMock(
  {
    exercise: [
      {
        dataSource: { platform: 'FITBIT', device: { displayName: 'Pixel Watch 4' } },
        exercise: {
          interval: { startTime: '2026-07-24T05:05:12.800Z', startUtcOffset: '32400s', endTime: '2026-07-24T05:24:34.400Z', endUtcOffset: '32400s' },
          exerciseType: 'WALKING',
          displayName: 'Walk',
          activeDuration: '1161.600s',
          metricsSummary: {
            caloriesKcal: '182',
            distanceMillimeters: '1620000',
            steps: '2100',
            averageHeartRateBeatsPerMinute: '104',
            activeZoneMinutes: '12',
            averagePaceSecondsPerMeter: 0.36,
            heartRateZoneDurations: { lightTime: '600s', moderateTime: '300s', vigorousTime: '116.6s', peakTime: '0s' },
          },
        },
      },
    ],
  },
  async (env) => {
    const r = await toolCall(env, 'get_workouts', { start_date: '2026-07-24', end_date: null });
    const w = ((r.structured?.workouts ?? []) as Array<Record<string, never>>)[0];
    check('workout returned', !!w, r.structured);
    check('local start time', w?.start_time === '14:05', w);
    check('activeDuration seconds → minutes', w?.active_minutes === 19, w);
    check('millimeters → km', w?.distance_km === 1.62, w);
    check('calories coerced', w?.calories_kcal === 182, w);
    check('avg heart rate coerced', w?.average_heart_rate_bpm === 104, w);
    check('total active minutes reported', r.structured?.total_active_minutes === 19, r.structured);
    check('seconds per meter becomes minutes per kilometer', w?.average_pace_minutes_per_km === 6, w);
    const zones = w?.heart_rate_zone_minutes as Record<string, number> | undefined;
    check('heart rate zone durations become minutes including a recorded zero', zones?.lightTime === 10 && zones.moderateTime === 5 && zones.peakTime === 0, zones);
    check('fractional zone durations retain precision', Math.abs((zones?.vigorousTime ?? 0) - 116.6 / 60) < 1e-9, zones);
    check('completed workout read is not marked truncated', r.structured?.truncated === false, r.structured);
  },
);

// ── weight ───────────────────────────────────────────────────────────────────

console.log('\nWeight');
await withMock(
  {
    weight: [
      { weight: { sampleTime: { civilTime: { date: { year: '2026', month: '7', day: '25' } } }, weightGrams: '68400' } },
      { weight: { sampleTime: { civilTime: { date: { year: '2026', month: '7', day: '18' } } }, weightGrams: '69100' } },
    ],
  },
  async (env) => {
    const r = await toolCall(env, 'get_body_metrics', { limit: null });
    const ms = (r.structured?.measurements ?? []) as Array<Record<string, never>>;
    check('weight read from sampleTime, not observationTime', ms[0]?.date === '2026-07-25', ms);
    check('grams → kg', ms[0]?.weight_kg === 68.4, ms);
    check('latest reported', r.structured?.latest_kg === 68.4, r.structured);
    check('change across readings computed', /-0\.7 kg/.test(r.text ?? ''), r.text);
  },
);
await withMock(
  { weight: [1, 2, 3, 4, 5].map((n) => ({ weight: { sampleTime: { civilTime: { date: { year: '2026', month: '7', day: String(n + 10) } } }, weightGrams: String(68000 + n) } })) },
  async (env) => {
    const r = await toolCall(env, 'get_body_metrics', { limit: 2 });
    check('limit is honoured', ((r.structured?.measurements ?? []) as unknown[]).length === 2, r.structured);
  },
);

// ── summary ──────────────────────────────────────────────────────────────────

console.log('\nDaily summary');
await withMock(
  {
    steps: [stepRollup('2026-07-24', '9876')],
    sleep: [
      {
        sleep: {
          interval: { startTime: '2026-07-23T15:00:00Z', startUtcOffset: '32400s', endTime: '2026-07-23T23:00:00Z', endUtcOffset: '32400s' },
          stages: [],
          summary: { minutesAsleep: '480' },
        },
      },
    ],
    'daily-resting-heart-rate': [
      { dailyRestingHeartRate: { date: { year: '2026', month: '7', day: '24' }, beatsPerMinute: '58' } },
    ],
    weight: [{ weight: { sampleTime: { civilTime: { date: { year: '2026', month: '7', day: '22' } } }, weightGrams: '68400' } }],
    exercise: [],
    'daily-heart-rate-variability': [{ dailyHeartRateVariability: { date: { year: 2026, month: 7, day: 24 }, rmssdMillis: '45' } }],
    'daily-oxygen-saturation': [{ dailyOxygenSaturation: { date: { year: 2026, month: 7, day: 24 }, oxygenSaturationPercentage: '98.2' } }],
    'active-energy-burned': [{ activeEnergyBurned: { energyKcalSum: '240' } }],
  },
  async (env) => {
    const r = await toolCall(env, 'get_health_summary', { date: '2026-07-24' });
    check('summary is not an error', !r.isError, r.text);
    check('steps included', r.structured?.steps === 9876, r.structured);
    check('resting heart rate matched to the date', r.structured?.resting_heart_rate_bpm === 58, r.structured);
    check('sleep minutes included', r.structured?.sleep_minutes_asleep === 480, r.structured);
    check('weight falls back to the most recent earlier reading', r.structured?.weight_kg === 68.4, r.structured);
    check('older weight is labelled as such', /last measured 2026-07-22/.test(r.text ?? ''), r.text);
    check('no workouts is stated, not omitted', !/## Workouts/.test(r.text ?? ''), r.text);
    check('summary requests the five base and seven extended metrics', recorded.length === 12, recorded.map(item => item.path));
    check('one token exchange serves all twelve parallel requests', tokenCalls === 1, { tokenCalls });
    const extras = r.structured?.extended_metrics as Record<string, unknown[]> | undefined;
    check('extended daily and activity measurements are retained', extras?.['daily-heart-rate-variability']?.length === 1 && extras?.['daily-oxygen-saturation']?.length === 1 && extras?.['active-energy-burned']?.length === 1, extras);
    check('summary weight queries an exclusive date bound upstream', recorded.find(item => item.path === 'weight')?.filter === 'weight.sample_time.civil_time < "2026-07-25"', recorded.find(item => item.path === 'weight'));
  },
);

await withMock(
  { steps: [stepRollup('2026-07-24', '0')], weight: [
    { weight: { sampleTime: { civilTime: { date: { year: 2026, month: 7, day: 25 } } }, weightGrams: '68400' } },
  ] },
  async (env) => {
    const r = await toolCall(env, 'get_health_summary', { date: '2026-07-24', include_extended: false });
    check('historical summary never falls back to a future weight', r.structured?.weight_kg === null && r.structured?.weight_measured_date === null, r.structured);
    check('future weight is not presented as a past measurement in text', !/Weight:|last measured/.test(r.text ?? ''), r.text);
    check('a recorded zero step rollup remains zero in summary', r.structured?.steps === 0, r.structured);
    check('disabling extended metrics requests only five types', recorded.length === 5, recorded.map(item => item.path));
    check('base-only summary still shares one token exchange', tokenCalls === 1, { tokenCalls });
  },
);

await withMock(
  { steps: [stepRollup('2026-07-24', '1234')] },
  async (env) => {
    const r = await toolCall(env, 'get_health_summary', { date: '2026-07-24' });
    const errors = r.structured?.errors as Record<string, string> | undefined;
    check('single-metric 403 leaves the summary successful', !r.isError, r.text);
    check('single-metric failure preserves the successful step total', r.structured?.steps === 1234, r.structured);
    check('failed metric includes actionable 403 details', /403/.test(errors?.sleep ?? '') && /scope/i.test(errors?.sleep ?? ''), errors);
    check('partial status is explained in text', /Partial result/.test(r.text ?? ''), r.text);
    check('partial result preserves the single token exchange', tokenCalls === 1, { tokenCalls });
  },
  { typeErrors: { sleep: { status: 403, body: { error: { code: 403, message: 'Insufficient authentication scopes.' } } } } },
);

// ── error paths ──────────────────────────────────────────────────────────────

console.log('\nError handling');
await withMock({ steps: [] }, async (env) => {
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: null });
  check('invalid_grant → actionable message', r.isError && /revoked|Testing|authorize\.py/.test(r.text ?? ''), r.text);
}, { tokenError: 'invalid_grant' });

await withMock({ steps: [] }, async (env) => {
  const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: null });
  check('other token errors are surfaced', r.isError && /token exchange failed/.test(r.text ?? ''), r.text);
}, { tokenError: 'unauthorized_client' });

await withMock(
  { steps: [] },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: null });
    // The fieldViolations description is how the filter grammar was discovered;
    // swallowing it would make future debugging much harder.
    check('fieldViolations description is surfaced verbatim', /not supported for filtering/.test(r.text ?? ''), r.text);
  },
  {
    apiError: {
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'Invalid data point filter',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'filter', description: "Member 'x.y' is not supported for filtering." }],
            },
          ],
        },
      },
    },
  },
);

await withMock(
  { steps: [] },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: null });
    check('429 mentions the rate limit', r.isError && /rate limit/i.test(r.text ?? ''), r.text);
  },
  { apiError: { status: 429, body: { error: { code: 429, message: 'Quota exceeded' } } } },
);

await withMock(
  { steps: [] },
  async (env) => {
    const r = await toolCall(env, 'get_steps_by_day', { start_date: '2026-07-24', end_date: null });
    check('403 suggests checking scopes', r.isError && /scope/i.test(r.text ?? ''), r.text);
  },
  { apiError: { status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.' } } } },
);

await withMock({ steps: [] }, async (env) => {
  const r = await toolCall({ ...env, GOOGLE_REFRESH_TOKEN: '' }, 'get_steps_by_day', {
    start_date: '2026-07-24',
    end_date: null,
  });
  check('missing credentials names the secrets and the script', /GOOGLE_REFRESH_TOKEN/.test(r.text ?? '') && /authorize\.py/.test(r.text ?? ''), r.text);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
