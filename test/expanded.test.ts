/**
 * Expanded read API contract, using synthetic fixtures and an in-process fetch
 * replacement. Every request is intercepted: no Google credentials or network
 * access are involved. Run with `node test/expanded.test.ts`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTools, type Env, type ToolAuthorization } from '../src/tools.ts';
import type { ToolResult } from '../src/mcp.ts';

interface RecordedRequest {
  url: URL;
  method: string;
  body: Record<string, unknown>;
}

const ENV: Env = {
  GOOGLE_CLIENT_ID: 'synthetic-client',
  GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  GOOGLE_REFRESH_TOKEN: 'synthetic-refresh',
  GOOGLE_TOKEN_URL: 'https://oauth.test/token',
  GOOGLE_API_BASE: 'https://health-api.test/v4',
  DEBUG_TOOLS: '0',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withGoogle(
  response: (request: RecordedRequest) => Response,
  run: (requests: RecordedRequest[], tokenCalls: () => number) => Promise<void>,
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  let exchanges = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://oauth.test' && url.pathname === '/token') {
      exchanges++;
      assert.equal(request.method, 'POST');
      return json({ access_token: 'synthetic-access', expires_in: 3599, token_type: 'Bearer' });
    }
    assert.ok(
      ['https://health-api.test', 'https://health.googleapis.com'].includes(url.origin),
      `Unexpected upstream origin: ${url.origin}`,
    );
    assert.equal(request.headers.get('Authorization'), 'Bearer synthetic-access');
    const text = await request.text();
    const recorded = {
      url,
      method: request.method,
      body: text ? JSON.parse(text) as Record<string, unknown> : {},
    };
    requests.push(recorded);
    return response(recorded);
  };
  try {
    await run(requests, () => exchanges);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function call(
  name: string,
  args: Record<string, unknown>,
  authorization?: ToolAuthorization,
): Promise<ToolResult> {
  const tool = buildTools(ENV, authorization).find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing tool ${name}`);
  return tool.handler(args, { env: ENV, headers: new Headers() });
}

function structured(result: ToolResult): Record<string, unknown> {
  assert.ok(result.structured, result.text);
  return result.structured;
}

test('catalog and all new tools retain the read permission contract', async () => {
  const names = ['list_health_data_types', 'query_health_data', 'aggregate_health_data'];
  const tools = buildTools(ENV);
  for (const name of names) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['health:read'] }]);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  await withGoogle(() => { throw new Error('Catalog must not access Google'); }, async (requests, tokenCalls) => {
    const catalog = structured(await call('list_health_data_types', {}));
    assert.ok(Array.isArray(catalog.data_types));
    const ids = catalog.data_types.map((item: { id: string }) => item.id);
    assert.ok(ids.includes('steps'));
    assert.ok(ids.includes('sleep'));
    assert.ok(ids.includes('daily-resting-heart-rate'));
    assert.ok(ids.length > 7, 'The catalog should extend the seven legacy client types');
    assert.equal(new Set(ids).size, ids.length, 'Catalog IDs must be unique');
    assert.equal(requests.length, 0);
    assert.equal(tokenCalls(), 0);
  });
});

test('new tools reject missing health scope before accessing upstream', async () => {
  await withGoogle(() => { throw new Error('Insufficient scope must not access Google'); }, async (requests, tokenCalls) => {
    for (const name of ['list_health_data_types', 'query_health_data', 'aggregate_health_data']) {
      await assert.rejects(
        call(name, {}, {
          scopes: new Set(['offline_access']),
          resourceMetadataUrl: 'https://mcp.test/.well-known/oauth-protected-resource/mcp',
        }),
        (error: any) => {
          assert.equal(error.structured?.required_scope, 'health:read');
          assert.match(error.meta?.['mcp/www_authenticate'] ?? '', /insufficient_scope/);
          return true;
        },
      );
    }
    assert.equal(requests.length, 0);
    assert.equal(tokenCalls(), 0);
  });
});

test('unknown types and ambiguous or invalid time ranges fail before accessing Google', async () => {
  await withGoogle(() => { throw new Error('Invalid arguments must not access Google'); }, async (requests, tokenCalls) => {
    const invalid: Array<Record<string, unknown>> = [
      { data_type: 'not-a-health-type', start_date: '2026-10-01', end_date: '2026-10-01' },
      { data_type: 'steps', start_date: '2026-02-30', end_date: '2026-03-01' },
      { data_type: 'steps', start_date: '2026-10-02', end_date: '2026-10-01' },
      {
        data_type: 'steps', start_date: '2026-10-01', end_date: '2026-10-02',
        start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-02T00:00:00Z',
      },
      { data_type: 'steps', start_time: '2026-10-01T00:00:00', end_time: '2026-10-02T00:00:00' },
      { data_type: 'steps', start_time: '2026-10-02T00:00:00Z', end_time: '2026-10-01T00:00:00Z' },
    ];
    for (const args of invalid) {
      await assert.rejects(call('query_health_data', args));
      await assert.rejects(call('aggregate_health_data', args));
    }
    await assert.rejects(call('aggregate_health_data', { data_type: 'steps' }));
    assert.equal(requests.length, 0);
    assert.equal(tokenCalls(), 0);
  });
});

test('upstream access denial remains actionable and is never returned as empty data', async () => {
  await withGoogle(
    () => json({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }, 403),
    async (requests) => {
      await assert.rejects(
        call('query_health_data', { data_type: 'steps', start_date: '2026-10-01', end_date: '2026-10-01' }),
        /403.*scope|scope.*403/i,
      );
      assert.equal(requests.length, 1);
    },
  );
});

test('raw and daily measurements use their own filters and preserve values and provenance', async () => {
  await withGoogle(
    (request) => {
      if (request.url.pathname.includes('/heart-rate/')) {
        return json({ dataPoints: [{
          name: 'users/synthetic-account/dataTypes/heart-rate/dataPoints/synthetic-point',
          dataSource: { platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED', device: { displayName: 'Synthetic Watch' } },
          heartRate: { sampleTime: { physicalTime: '2026-10-01T00:00:00Z' }, beatsPerMinute: '0' },
        }] });
      }
      return json({ dataPoints: [{ dailyOxygenSaturation: {
        date: { year: 2026, month: 10, day: 1 },
        oxygenSaturationPercentage: '98.2',
      } }] });
    },
    async (requests) => {
      const raw = structured(await call('query_health_data', {
        data_type: 'heart-rate', start_time: '2026-10-01T09:00:00+09:00', end_time: '2026-10-01T10:00:00+09:00',
      }));
      assert.equal(requests[0]?.method, 'GET');
      assert.equal(requests[0]?.url.pathname, '/v4/users/me/dataTypes/heart-rate/dataPoints');
      assert.equal(requests[0]?.url.searchParams.get('filter'),
        'heart_rate.sample_time.physical_time >= "2026-10-01T09:00:00+09:00" AND heart_rate.sample_time.physical_time < "2026-10-01T10:00:00+09:00"');
      assert.deepEqual(raw.records, [{
        record_id: 'synthetic-point',
        data: { sampleTime: { physicalTime: '2026-10-01T00:00:00Z' }, beatsPerMinute: '0' },
        source: { platform: 'FITBIT', recording_method: 'PASSIVELY_MEASURED', device: { displayName: 'Synthetic Watch' } },
      }]);
      assert.equal(JSON.stringify(raw).includes('synthetic-account'), false, 'Resource names must not leak account identifiers');

      const daily = structured(await call('query_health_data', {
        data_type: 'daily-oxygen-saturation', start_date: '2026-10-01', end_date: '2026-10-02',
      }));
      assert.equal(requests[1]?.url.pathname, '/v4/users/me/dataTypes/daily-oxygen-saturation/dataPoints');
      assert.equal(requests[1]?.url.searchParams.get('filter'),
        'daily_oxygen_saturation.date >= "2026-10-01" AND daily_oxygen_saturation.date < "2026-10-03"');
      assert.equal((daily.records as any[])[0].data.oxygenSaturationPercentage, '98.2');
      assert.equal(daily.has_more, false);
      assert.equal(daily.next_page_token, null);
      assert.equal(requests.length, 2);
    },
  );
});

test('beta skin sensors use the beta route and retain the native sensor array', async () => {
  const sensorData = {
    sampleTime: { physicalTime: '2026-10-01T00:00:00Z' },
    sensorData: [
      { temperatureCelsius: 32.75, metadata: { sensorLocation: 'WRIST' } },
      { temperatureCelsius: 0, metadata: { sensorLocation: 'UNKNOWN' } },
    ],
  };
  await withGoogle(() => json({ dataPoints: [{ skinTemperatureSensors: sensorData }] }), async (requests) => {
    const result = structured(await call('query_health_data', {
      data_type: 'skin-temperature-sensors', start_date: '2026-10-01',
    }));
    assert.equal(requests[0]?.url.pathname, '/v4beta/users/me/dataTypes/skin-temperature-sensors/dataPoints');
    assert.equal(result.api_version, 'v4beta');
    assert.deepEqual(result.records, [{ data: sensorData }]);
    await assert.rejects(call('query_health_data', { data_type: 'skin-temperature-sensors', reconcile: true }), /reconcile/i);
    assert.equal(requests.length, 1, 'Unsupported reconciliation must fail before another request');
  });
});

test('source filtering and opaque continuation tokens round trip without auto-pagination', async () => {
  const nextToken = 'opaque+/cursor=token';
  await withGoogle(
    (request) => json({ dataPoints: [], ...(request.url.searchParams.has('pageToken') ? {} : { nextPageToken: nextToken }) }),
    async (requests) => {
      for (const family of ['all-sources', 'google-wearables', 'google-sources', 'self-sources']) {
        const result = structured(await call('query_health_data', { data_type: 'steps', data_source: family, limit: 7 }));
        const request = requests.at(-1)!;
        assert.equal(request.url.searchParams.get('dataSourceFamily'), `users/me/dataSourceFamilies/${family}`);
        assert.equal(request.url.searchParams.get('pageSize'), '7');
        assert.equal(result.has_more, true);
        assert.equal(result.next_page_token, nextToken);
        assert.deepEqual(result.records, [], 'No measurements must remain empty, never a fabricated zero');
      }
      assert.equal(requests.length, 4, 'Each tool call must fetch exactly one page');
      const resumed = structured(await call('query_health_data', {
        data_type: 'steps', data_source: 'google-wearables', limit: 7, page_token: nextToken,
      }));
      assert.equal(requests.at(-1)?.url.searchParams.get('pageToken'), nextToken);
      assert.equal(resumed.has_more, false);
      assert.equal(resumed.next_page_token, null);
      assert.equal(requests.length, 5);
    },
  );
});

test('reconciled reads select the merge endpoint and sleep source restrictions remain explicit', async () => {
  await withGoogle(() => json({ dataPoints: [{ steps: { count: '9007199254740993' } }] }), async (requests) => {
    const result = structured(await call('query_health_data', {
      data_type: 'steps', reconcile: true, data_source: 'all-sources', start_date: '2026-10-01',
    }));
    assert.equal(requests[0]?.url.pathname, '/v4/users/me/dataTypes/steps/dataPoints:reconcile');
    assert.equal(requests[0]?.method, 'GET');
    assert.equal(result.reconciled, true);
    assert.equal((result.records as any[])[0].data.count, '9007199254740993', 'int64 strings must not lose precision');
    await assert.rejects(call('query_health_data', { data_type: 'sleep', data_source: 'google-wearables' }), /reconcile/i);
    await assert.rejects(call('query_health_data', { data_type: 'total-calories' }), /list/i);
    assert.equal(requests.length, 1);
  });
});

test('daily rollups send inclusive calendar bounds, page controls and preserve missing versus zero', async () => {
  const records = [
    { civilStartTime: { date: { year: 2026, month: 10, day: 1 } }, steps: { countSum: '0' } },
    { civilStartTime: { date: { year: 2026, month: 10, day: 2 } }, steps: {} },
  ];
  await withGoogle(() => json({ rollupDataPoints: records, nextPageToken: 'rollup-next' }), async (requests) => {
    const result = structured(await call('aggregate_health_data', {
      data_type: 'steps', start_date: '2026-10-01', end_date: '2026-10-14',
      window_days: 7, limit: 2, page_token: 'rollup-prior', data_source: 'google-wearables',
    }));
    const request = requests[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url.pathname, '/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp');
    assert.deepEqual(request.body, {
      range: {
        start: { date: { year: 2026, month: 10, day: 1 }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
        end: { date: { year: 2026, month: 10, day: 15 }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } },
      },
      windowSizeDays: 7,
      pageSize: 2,
      pageToken: 'rollup-prior',
      dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
    });
    assert.deepEqual(result.records, records);
    assert.equal((result.records as any[])[0].steps.countSum, '0');
    assert.equal(Object.hasOwn((result.records as any[])[1].steps, 'countSum'), false);
    assert.equal(result.reconciled, true);
    assert.equal(result.next_page_token, 'rollup-next');
    assert.equal(result.has_more, true);
    assert.equal(requests.length, 1);
  });
});

test('physical rollups retain explicit offsets and validate storage-resolution and type limits', async () => {
  await withGoogle(() => json({ rollupDataPoints: [] }), async (requests) => {
    const result = structured(await call('aggregate_health_data', {
      data_type: 'heart-rate', start_time: '2026-10-01T09:00:00+09:00', end_time: '2026-10-01T11:00:00+09:00',
      window_seconds: 3600, data_source: 'all-sources',
    }));
    assert.equal(requests[0]?.url.pathname, '/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp');
    assert.deepEqual(requests[0]?.body, {
      range: { startTime: '2026-10-01T09:00:00+09:00', endTime: '2026-10-01T11:00:00+09:00' },
      windowSize: '3600s', pageSize: 100, dataSourceFamily: 'users/me/dataSourceFamilies/all-sources',
    });
    assert.deepEqual(result.records, []);
    assert.equal(result.next_page_token, null);
    assert.equal(result.has_more, false);

    const physical = { data_type: 'heart-rate', start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-02T00:00:00Z' };
    await assert.rejects(call('aggregate_health_data', { ...physical, window_seconds: 1 }), /60/);
    await assert.rejects(call('aggregate_health_data', { ...physical, window_days: 1 }), /window_seconds/);
    await assert.rejects(call('aggregate_health_data', { ...physical, start_time: '2026-10-01T00:30:00Z' }), /align/i);
    await assert.rejects(call('aggregate_health_data', { data_type: 'sleep', start_date: '2026-10-01' }), /aggregation/i);
    // The REST union mentions these rollups, but the real service explicitly
    // supports only list/reconcile for these types.
    for (const data_type of ['daily-resting-heart-rate', 'daily-heart-rate-variability']) {
      await assert.rejects(call('aggregate_health_data', { data_type, start_date: '2026-10-01' }), /aggregation/i);
    }
    await assert.rejects(call('query_health_data', {
      data_type: 'exercise', start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-02T00:00:00Z',
    }), /local date/i);
    await assert.rejects(call('aggregate_health_data', { data_type: 'heart-rate', start_date: '2026-10-01', end_date: '2026-10-15' }), /14/);
    assert.equal(requests.length, 1, 'Rejected aggregation requests must not hit upstream');
  });
});
