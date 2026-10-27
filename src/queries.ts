import { DATA_TYPES, type SourceFamily } from './catalog.ts';
import { GoogleHealthClient, GoogleHealthError, type DataType } from './google.ts';
import { ToolError, type ToolDefinition } from './mcp.ts';

const DAY_MS = 86_400_000;
const SOURCES = ['all-sources', 'google-wearables', 'google-sources', 'self-sources'] as const;

export function realDate(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new ToolError(`${key} must be a real date in YYYY-MM-DD form.`);
  }
  const date = value.trim();
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new ToolError(`${key}: ${date} is not a real calendar date.`);
  }
  return date;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function integer(args: Record<string, unknown>, key: string, fallback: number, max: number, min = 1): number {
  const value = args[key];
  if (!present(value)) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${key} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function timestamp(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ToolError(`${key} must be an RFC3339 timestamp with Z or an explicit UTC offset.`);
  }
  realDate(value.slice(0, 10), key);
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59 || !Number.isFinite(Date.parse(value))) {
    throw new ToolError(`${key} is not a valid timestamp.`);
  }
  return value;
}

function selectedType(args: Record<string, unknown>): DataType {
  if (typeof args.data_type !== 'string' || !Object.hasOwn(DATA_TYPES, args.data_type)) {
    throw new ToolError('Unknown data_type. Use list_health_data_types to find supported identifiers.');
  }
  return args.data_type as DataType;
}

function selection(args: Record<string, unknown>, required: boolean, maxDays: number) {
  const civil = present(args.start_date) || present(args.end_date);
  const physical = present(args.start_time) || present(args.end_time);
  if (civil && physical) throw new ToolError('Use either local dates or physical timestamps in a call, not both.');
  if (!civil && !physical) {
    if (required) throw new ToolError('Provide start_date or both start_time and end_time.');
    return {};
  }
  if (civil) {
    const startDate = realDate(args.start_date, 'start_date');
    const endDate = present(args.end_date) ? realDate(args.end_date, 'end_date') : startDate;
    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    const endMs = Date.parse(`${endDate}T00:00:00Z`);
    if (endMs < startMs) throw new ToolError('end_date must be on or after start_date.');
    if ((endMs - startMs) / DAY_MS + 1 > maxDays) throw new ToolError(`This data type allows at most ${maxDays} days per call. Split longer periods into multiple calls.`);
    const endDateExclusive = new Date(endMs + DAY_MS).toISOString().slice(0, 10);
    if (!/^\d{4}-/.test(endDateExclusive)) throw new ToolError('end_date must be before 9999-12-31.');
    return { startDate, endDateExclusive };
  }
  const startTime = timestamp(args.start_time, 'start_time');
  const endTime = timestamp(args.end_time, 'end_time');
  const duration = Date.parse(endTime) - Date.parse(startTime);
  if (duration <= 0 || duration > maxDays * DAY_MS) throw new ToolError(`Physical time ranges must be positive and no wider than ${maxDays} days; end_time is exclusive.`);
  return { startTime, endTime };
}

function pageOptions(args: Record<string, unknown>) {
  const pageSize = integer(args, 'limit', 100, 500);
  let pageToken: string | undefined;
  if (present(args.page_token)) {
    if (typeof args.page_token !== 'string' || args.page_token.length > 8192) throw new ToolError('page_token must be an opaque string of at most 8192 characters.');
    pageToken = args.page_token;
  }
  let sourceFamily: SourceFamily | undefined;
  if (present(args.data_source)) {
    if (!SOURCES.includes(args.data_source as typeof SOURCES[number])) throw new ToolError(`data_source must be one of ${SOURCES.join(', ')}.`);
    sourceFamily = args.data_source as SourceFamily;
  }
  return { pageSize, pageToken, sourceFamily };
}

const properties = {
  data_type: { type: 'string', enum: Object.keys(DATA_TYPES), description: 'Exact ID from list_health_data_types.' },
  start_date: { type: ['string', 'null'], description: 'First LOCAL date, YYYY-MM-DD. Pass null for physical timestamps or a newest-first page.' },
  end_date: { type: ['string', 'null'], description: 'Last LOCAL date, inclusive. Defaults to start_date.' },
  start_time: { type: ['string', 'null'], description: 'Physical start timestamp, inclusive, RFC3339 with timezone. Requires end_time; do not combine with dates.' },
  end_time: { type: ['string', 'null'], description: 'Physical end timestamp, exclusive, RFC3339 with timezone.' },
  data_source: { type: ['string', 'null'], enum: [...SOURCES, null], description: 'all-sources, Google wearables only, Google sources including Health Connect, or this client\'s own writes. Pass null to use the API default.' },
  limit: { type: ['integer', 'null'], minimum: 1, maximum: 500, description: 'Requested page size, default 100, maximum 500. The API may return a different count, especially beta sensors; full pages are preserved to avoid data loss.' },
  page_token: { type: ['string', 'null'], description: 'Opaque next_page_token from the previous result. Keep all other arguments identical when resuming.' },
};

function apiError(error: unknown): never {
  throw new ToolError(error instanceof GoogleHealthError || error instanceof Error ? error.message : String(error));
}

export function buildQueryTools<Env>(clientFor: (env: Env) => GoogleHealthClient): Array<ToolDefinition<Env>> {
  return [
    {
      name: 'list_health_data_types',
      title: 'Available health data types and query capabilities',
      description: 'Discover health data supported by this MCP: HRV, SpO2, respiration, temperature, VO2 max, heart rate, body composition, activity and more. This is a capability catalog, not proof that the user has recorded each metric. Beta entries are marked explicitly.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      async handler() {
        const data_types = Object.entries(DATA_TYPES).map(([id, definition]) => ({ id, ...definition }));
        return { text: data_types.map(t => `${t.id}: ${t.recordType}, ${t.version}, ${t.scope}`).join('\n'), structured: { data_types, note: 'Nutrition, ECG and IRN require additional Google scopes; a catalog entry does not imply consent. Availability depends on device, account and recorded data. Numeric strings and native API units are preserved.' } };
      },
    },
    {
      name: 'query_health_data',
      title: 'Flexible health measurements and sessions',
      description: 'Read one page of any catalog health metric with a LOCAL date range (up to 120 days), precise physical timestamps, optional source filtering and resumable pagination. Without dates, returns one newest-first page. Use reconcile=true to merge overlapping sources where supported. Returns native API payloads; numeric strings preserve int64 precision. Raw skin-temperature-sensors automatically uses v4beta and requires compatible hardware. Missing records mean no data, never zero.',
      inputSchema: { type: 'object', properties: { ...properties, reconcile: { type: ['boolean', 'null'], description: 'Merge overlapping data sources using reconcile (when supported). Default false; true for reconciled sensor streams.' } }, required: [...Object.keys(properties), 'reconcile'], additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const type = selectedType(args);
        const r = selection(args, false, 120);
        const options = pageOptions(args);
        if (present(args.reconcile) && typeof args.reconcile !== 'boolean') throw new ToolError('reconcile must be a boolean.');
        const reconcile = args.reconcile === true;
        const definition = DATA_TYPES[type];
        if (reconcile ? !definition.reconcile : !definition.list) throw new ToolError(`${type} does not support ${reconcile ? 'reconcile' : 'list'}. Check list_health_data_types for supported operations.`);
        if (r.startTime && !definition.filterField.physical) throw new ToolError(`${type} requires local date filtering; physical timestamps are not supported for this type.`);
        if (type === 'sleep' && options.sourceFamily && !reconcile) throw new ToolError('Source filtering on sleep requires reconcile=true. The sleep list endpoint does not support data_source.');
        try {
          const page = await clientFor(ctx.env).listPage(type, { ...r, ...options, reconcile });
          const records = page.points.map(point => ({
            ...(typeof point.name === 'string' ? { record_id: point.name.split('/').at(-1) } : {}),
            data: GoogleHealthClient.payload(type, point),
            ...(point.dataSource ? { source: { platform: point.dataSource.platform, recording_method: point.dataSource.recordingMethod, device: point.dataSource.device } } : {}),
          }));
          return { text: `${type}: ${records.length} record(s)${page.nextPageToken ? '; more available — resume using next_page_token and identical arguments' : ''}.\n${JSON.stringify(records)}`, structured: { data_type: type, api_version: definition.version, reconciled: reconcile, records, next_page_token: page.nextPageToken ?? null, has_more: !!page.nextPageToken } };
        } catch (error) { apiError(error); }
      },
    },
    {
      name: 'aggregate_health_data',
      title: 'Reconciled daily, weekly or intraday health aggregates',
      description: 'Aggregate health metrics on Google\'s servers, reconciling overlapping devices. Use LOCAL dates and window_days for daily or multi-day trends; use physical timestamps and window_seconds for hourly/minute-level charts. Catalog lists supported types. Most ranges allow 90 days; heart-rate, active-minutes, total-calories and calories-in-heart-rate-zone allow 14 days. One resumable page per call; API-native sums/averages/min/max and units are preserved. Missing buckets are not zero.',
      inputSchema: { type: 'object', properties: { ...properties,
        window_days: { type: ['integer', 'null'], minimum: 1, maximum: 90, description: 'Calendar days per bucket, default 1. Only with start_date.' },
        window_seconds: { type: ['integer', 'null'], minimum: 60, maximum: 86400, description: 'Seconds per physical bucket, default 3600, minimum 60 to avoid storage-resolution artifacts. Start timestamp must align to this window.' },
      }, required: [...Object.keys(properties), 'window_days', 'window_seconds'], additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const type = selectedType(args);
        const definition = DATA_TYPES[type];
        const r = selection(args, true, definition.maxAggregateDays);
        const options = pageOptions(args);
        if (r.startDate ? !definition.dailyRollup : !definition.rollup) throw new ToolError(`${type} does not support ${r.startDate ? 'daily' : 'physical'} aggregation. Use query_health_data instead.`);
        let windowSizeDays: number | undefined;
        let windowSeconds: number | undefined;
        if (r.startDate) {
          if (present(args.window_seconds)) throw new ToolError('Use window_days with local dates.');
          windowSizeDays = integer(args, 'window_days', 1, 90);
        } else {
          if (present(args.window_days)) throw new ToolError('Use window_seconds with physical timestamps.');
          windowSeconds = integer(args, 'window_seconds', 3600, 86400, 60);
          if (Date.parse(r.startTime!) % (windowSeconds * 1000) !== 0) throw new ToolError('start_time must align to window_seconds (for example, start on the hour for 3600).');
        }
        try {
          const page = await clientFor(ctx.env).aggregatePage(type, { ...r, ...options, windowSizeDays, windowSeconds });
          return { text: `${type}: ${page.points.length} reconciled window(s)${page.nextPageToken ? '; more available — resume using next_page_token and identical arguments' : ''}.\n${JSON.stringify(page.points)}`, structured: { data_type: type, api_version: definition.version, reconciled: true, records: page.points, next_page_token: page.nextPageToken ?? null, has_more: !!page.nextPageToken } };
        } catch (error) { apiError(error); }
      },
    },
  ];
}
