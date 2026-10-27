import { GoogleHealthClient, civilDate, durationSeconds, intervalLocalEndDate, intervalLocalStartDate, localTimeOfDay, num, type DataPoint, type DataType } from './google.ts';
import { realDate } from './queries.ts';
import { ToolError, type ToolDefinition, type ToolResult } from './mcp.ts';
import type { Env } from './tools.ts';

const DAY = 86_400_000;
type Obj = Record<string, any>;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const output = (data: Obj): ToolResult => ({ text: JSON.stringify(data), structured: data });
const str = (description: string) => ({ type: 'string', description });
const nullable = (description: string) => ({ type: ['string', 'null'], description });
function readTool(name: string, description: string, properties: Obj, handler: ToolDefinition<Env>['handler']): ToolDefinition<Env> {
  return { name, description, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }, handler };
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new ToolError('record_id must be an opaque record ID, not a URL.');
  return value;
}
function pageToken(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.length > 8192) throw new ToolError('Invalid page_token');
  return value;
}
export function statistics(values: number[], days: number) {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return { observed_days: values.length, expected_days: days, coverage: values.length / days, mean,
    standard_deviation: mean === null ? null : Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length),
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
}
export function sleepAnalysis(records: Obj[], days: number) {
  const nights = new Map<string, { minutes: number; mainMinutes: number; bedtime?: number }>();
  for (const s of records) {
    const date = intervalLocalEndDate(s.interval);
    const minutes = num(s.summary?.minutesAsleep);
    if (!date || minutes === undefined) continue;
    const previous = nights.get(date);
    const time = localTimeOfDay(s.interval?.startTime, s.interval?.startUtcOffset);
    const [h, m] = (time ?? '').split(':').map(Number);
    const clock = h !== undefined && m !== undefined && Number.isFinite(h + m) ? h * 60 + m : undefined;
    // Anchor at noon so 23:50 and 00:10 differ by 20 minutes, not 23h40m.
    const bedtime = clock === undefined ? undefined : clock < 720 ? clock + 1440 : clock;
    nights.set(date, { minutes: (previous?.minutes ?? 0) + minutes, mainMinutes: Math.max(previous?.mainMinutes ?? 0, minutes), bedtime: previous && previous.mainMinutes > minutes ? previous.bedtime : bedtime });
  }
  const bedtimes = [...nights.values()].flatMap(n => n.bedtime === undefined ? [] : [n.bedtime]);
  return { duration_minutes: statistics([...nights.values()].map(n => n.minutes), days), bedtime_variation_minutes: statistics(bedtimes, days).standard_deviation,
    nights: [...nights.entries()].map(([date, n]) => ({ date, minutes_asleep: n.minutes })),
    method: 'Sleep grouped by local end date; bedtime uses the longest session per date, anchored at noon. Missing days are excluded, not zero.' };
}

async function period(client: GoogleHealthClient, start: string, end: string) {
  const days = (Date.parse(end) - Date.parse(start)) / DAY + 1;
  const errors: Obj = {}; const truncated: string[] = []; const rows: Partial<Record<DataType, DataPoint[]>> = {};
  const types = ['steps', 'sleep', 'exercise', 'daily-resting-heart-rate', 'daily-heart-rate-variability', 'daily-oxygen-saturation'] as const;
  await Promise.all(types.map(async type => {
    try {
      const collected: DataPoint[] = []; let cursor: string | undefined;
      for (let page = 0; page < 2; page++) {
        const opts = { startDate: start, endDateExclusive: shift(end, 1), pageToken: cursor, pageSize: 100, sourceFamily: 'all-sources' as const };
        const result = type === 'steps' ? await client.aggregatePage(type, { ...opts, windowSizeDays: 1 }) : await client.listPage(type, { ...opts, reconcile: true });
        collected.push(...result.points); cursor = result.nextPageToken;
        if (!cursor) break;
      }
      if (cursor) truncated.push(type);
      rows[type] = collected;
    } catch (error) { errors[type] = error instanceof Error ? error.message : String(error); }
  }));
  if (Object.keys(errors).length === types.length) throw new ToolError('All report queries failed.', { errors });
  const metrics: Obj = {};
  for (const [type, field, unit] of [
    ['steps', 'countSum', 'steps/day'], ['daily-resting-heart-rate', 'beatsPerMinute', 'bpm'],
    ['daily-heart-rate-variability', 'averageHeartRateVariabilityMilliseconds', 'ms'], ['daily-oxygen-saturation', 'averagePercentage', '%'],
  ] as const) {
    const daily = new Map<string, number>();
    for (const point of rows[type] ?? []) {
      const payload = GoogleHealthClient.payload(type, point) as Obj;
      const date = civilDate((point as Obj).civilStartTime) ?? civilDate(payload.date) ?? intervalLocalStartDate((point as Obj).interval) ?? civilDate((point as Obj).interval?.start);
      const n = num(payload[field]);
      if (date && date >= start && date <= end && n !== undefined) daily.set(date, n);
    }
    metrics[type] = { unit, ...statistics([...daily.values()], days) };
  }
  const sleep = sleepAnalysis((rows.sleep ?? []).map(p => GoogleHealthClient.payload('sleep', p)), days);
  metrics.sleep = { unit: 'minutes/day', ...sleep.duration_minutes };
  const workouts = (rows.exercise ?? []).map(p => GoogleHealthClient.payload('exercise', p) as Obj);
  return { start_date: start, end_date: end, metrics, sleep, workouts: { count: errors.exercise ? null : workouts.length,
    observed_active_minutes: errors.exercise ? null : workouts.reduce((sum, w) => sum + (durationSeconds(w.activeDuration) ?? 0) / 60, 0) }, errors, truncated,
    complete: !Object.keys(errors).length && !truncated.length };
}

export function buildFeatureTools(clientFor: (env: Env) => GoogleHealthClient): ToolDefinition<Env>[] {
  return [
    readTool('get_health_report', 'Build a weekly/monthly report for up to 31 LOCAL days, with equal-length prior-period comparison, sleep regularity, coverage and partial errors. Descriptive personal trends, not Google readiness/sleep scores or medical diagnosis.', {
      start_date: str('First local date, YYYY-MM-DD.'), end_date: str('Last local date inclusive, maximum 31 days.'), compare_previous: { type: ['boolean', 'null'], description: 'Default true: compare with the immediately preceding equal-length period.' },
    }, async (args, ctx) => {
      const start = realDate(args.start_date, 'start_date'), end = realDate(args.end_date, 'end_date');
      const days = (Date.parse(end) - Date.parse(start)) / DAY + 1;
      if (days < 1 || days > 31) throw new ToolError('Report range must be 1–31 days.');
      if (args.compare_previous != null && typeof args.compare_previous !== 'boolean') throw new ToolError('compare_previous must be boolean');
      const client = clientFor(ctx.env); const current = await period(client, start, end);
      let previous: Awaited<ReturnType<typeof period>> | null = null;
      let previousError: string | null = null;
      if (args.compare_previous !== false) {
        try { previous = await period(client, shift(start, -days), shift(start, -1)); }
        catch (error) { previousError = error instanceof Error ? error.message : String(error); }
      }
      const changes: Obj = {};
      if (previous) for (const key of Object.keys(current.metrics)) {
        const a = current.metrics[key], b = previous.metrics[key];
        const valid = a.mean !== null && b.mean !== null;
        changes[key] = { mean_change: valid ? a.mean - b.mean : null, percent_change: valid && b.mean !== 0 ? (a.mean - b.mean) / Math.abs(b.mean) * 100 : null,
          comparable: valid && a.coverage >= .7 && b.coverage >= .7 && !current.truncated.includes(key) && !previous.truncated.includes(key),
          note: 'Means use observed days only; compare coverage before interpreting change.' };
      }
      return output({ current, previous, previous_error: previousError, changes, interpretation: 'Descriptive comparison, not a clinical assessment or Google proprietary score.' });
    }),
    readTool('get_nutrition_summary', 'Summarize logged food calories, macros and hydration by local date, up to 31 days. Requires nutrition.readonly. Only recorded consumption is counted; missing logs/fields remain null and partial pages are reported.', { start_date: str('First local date YYYY-MM-DD.'), end_date: str('Last local date inclusive.') }, async (args, ctx) => {
      const start = realDate(args.start_date, 'start_date'), end = realDate(args.end_date, 'end_date');
      const count = (Date.parse(end) - Date.parse(start)) / DAY + 1;
      if (count < 1 || count > 31) throw new ToolError('Nutrition range must be 1–31 days.');
      const client = clientFor(ctx.env), errors: Obj = {}, truncated: string[] = [];
      const days: Obj = Object.fromEntries(Array.from({length:count}, (_, i) => [shift(start, i), { kcal: null, protein_grams: null, carbohydrate_grams: null, fat_grams: null, water_ml: null }]));
      for (const type of ['nutrition-log', 'hydration-log'] as const) {
        try {
          let cursor: string | undefined;
          for (let page=0;page<3;page++) {
            const result = await client.listPage(type, { startDate: start, endDateExclusive: shift(end, 1), pageToken: cursor, pageSize: 100, reconcile: true });
            for (const point of result.points) {
              const payload = GoogleHealthClient.payload(type, point) as Obj;
              const date = intervalLocalStartDate(payload.interval); if (!date || !days[date]) continue;
              const add = (key: string, value: unknown) => { const n = num(value); if(n !== undefined) days[date][key] = (days[date][key] ?? 0) + n; };
              if(type === 'hydration-log') add('water_ml',payload.amountConsumed?.milliliters);
              else {
                add('kcal',payload.energy?.kcal); add('carbohydrate_grams',payload.totalCarbohydrate?.grams); add('fat_grams',payload.totalFat?.grams);
                for(const nutrient of payload.nutrients ?? []) if(nutrient.nutrient === 'PROTEIN') add('protein_grams',nutrient.quantity?.grams);
              }
            }
            cursor = result.nextPageToken; if(!cursor) break;
          }
          if(cursor) truncated.push(type);
        } catch(error) { errors[type] = error instanceof Error ? error.message : String(error); }
      }
      if(Object.keys(errors).length === 2) throw new ToolError('Nutrition and hydration reads failed. Check Google nutrition.readonly consent.', { errors });
      return output({ start_date:start, end_date:end, days:Object.entries(days).map(([date, values]) => ({date,...values as Obj})), errors, truncated, complete:!Object.keys(errors).length && !truncated.length });
    }),
    readTool('get_workout_details', 'Read a single workout with per-lap splits, pause/resume events and raw metrics. Get record_id from query_health_data(exercise). Splits exist only when recorded.', { record_id: str('Opaque exercise record ID.') }, async (args, ctx) => {
      const result = await clientFor(ctx.env).workout(id(args.record_id)); const w = result.exercise ?? {};
      return output({ record_id: args.record_id, exercise: w, laps: (w.splitSummaries ?? w.splits ?? []).map((lap: Obj) => {
        const m = lap.metricsSummary ?? {}; const meters = (num(m.distanceMillimeters) ?? 0) / 1000; const seconds = durationSeconds(lap.activeDuration);
        return { ...lap, distance_km: meters / 1000, active_minutes: seconds == null ? null : seconds / 60,
          pace_minutes_per_km: seconds != null && meters > 0 ? seconds / 60 / (meters / 1000) : null };
      }) });
    }),
    readTool('export_workout_tcx', 'Export a workout as TCX XML (max 1 MB). Requires BOTH activity_and_fitness.readonly and location.readonly. Includes location when recorded; this tool returns the file content without uploading it anywhere.', { record_id: str('Opaque exercise record ID.'), include_without_gps: { type: ['boolean', 'null'], description: 'Default false. Set true to request partial data when GPS is absent.' } }, async (args, ctx) => {
      if (args.include_without_gps != null && typeof args.include_without_gps !== 'boolean') throw new ToolError('include_without_gps must be boolean');
      const xml = await clientFor(ctx.env).exportWorkout(id(args.record_id), args.include_without_gps === true);
      return { text: xml };
    }),
    readTool('get_health_devices', 'List paired Google/Fitbit devices with battery and last sync time. Requires settings.readonly. A stale sync is a possible explanation for missing data, not proof of its cause.', { page_token: nullable('Continuation token, or null for first page.') }, async (args, ctx) => {
      const data = await clientFor(ctx.env).pairedDevices(pageToken(args.page_token));
      return output({ devices: (data.pairedDevices ?? []).map((d: Obj) => ({ device_id: d.name?.split('/').at(-1), device_type: d.deviceType ?? null, device_version: d.deviceVersion ?? null, battery_level: d.batteryLevel ?? null, battery_status: d.batteryStatus ?? null, last_sync_time: d.lastSyncTime ?? null, features: d.features ?? [] })), next_page_token: data.nextPageToken ?? null });
    }),
    readTool('get_health_account', 'Read account settings, profile or IRN enrollment. Requires settings.readonly, profile.readonly or irn.readonly respectively. Settings include timezone and preferred units.', { resource: { type: 'string', enum: ['settings', 'profile', 'irnProfile'], description: 'Account resource to read.' } }, async (args, ctx) => {
      if (!['settings', 'profile', 'irnProfile'].includes(String(args.resource))) throw new ToolError('Unsupported account resource');
      const data = await clientFor(ctx.env).accountResource(args.resource as 'settings'); delete data.name;
      return output(data);
    }),
    readTool('get_health_connection_status', 'Inspect granted Google scope names (when returned by Google), enabled write capability and latest webhook sync markers. Never returns credentials or personal measurement values.', {}, async (_args, ctx) => {
      const status = await clientFor(ctx.env).authorizationStatus();
      const latest = ctx.env.OAUTH_KV ? await ctx.env.OAUTH_KV.get('health:webhook:last', 'json') : null;
      return output({ ...status, writes_enabled: ctx.env.ENABLE_WRITES === '1', webhooks_enabled: !!ctx.env.WEBHOOK_SECRET && !!ctx.env.WEBHOOK_HEALTH_USER_ID, last_webhook: latest,
        note: 'An omitted Google scope response is unknown, not an empty permission set. New Google permissions require Google consent; reconnecting MCP alone does not grant them.' });
    }),
  ];
}
