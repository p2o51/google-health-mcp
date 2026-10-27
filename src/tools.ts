import { buildFeatureTools } from './features.ts';
import { buildWriteTools } from './writes.ts';
import { buildQueryTools, realDate } from './queries.ts';
/**
 * Health data tools.
 *
 * Dates in and out are always CIVIL (local) dates, and the filters use the
 * `civil_*` variants, so "2026-07-24" means July 24 where the data was recorded
 * rather than in UTC. Getting this wrong misfiles roughly a third of sleep
 * sessions, which routinely start after midnight UTC-shifted.
 *
 * Steps use server-side dailyRollUp so overlapping devices are reconciled.
 * Every query has a range or page budget; flexible queries retain continuation
 * tokens and preserve native API units and int64 strings.
 */

import {
  GoogleHealthClient,
  GoogleHealthError,
  civilDate,
  durationSeconds,
  intervalLocalEndDate,
  intervalLocalStartDate,
  localTimeOfDay,
  localDate,
  num,
  type DataPoint,
  type Interval,
} from './google.ts';
import { ToolError, type ToolDefinition } from './mcp.ts';

export interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  DEBUG_TOOLS?: string;
  ENABLE_WRITES?: string;
  OAUTH_KV?: KVNamespace;
  WEBHOOK_SECRET?: string;
  WEBHOOK_HEALTH_USER_ID?: string;
  /** Test hooks. Unset in production. */
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_API_BASE?: string;
}

export const HEALTH_READ_SCOPE = 'health:read';
export const HEALTH_WRITE_SCOPE = 'health:write';
export interface ToolAuthorization {
  scopes: ReadonlySet<string>;
  resourceMetadataUrl: string;
}

/**
 * The stable API allows up to 90 days of reconciled step aggregation.
 */
const MAX_STEP_SPAN_DAYS = 90;
/** Sleep and workouts are one record per night/session, so a quarter is fine. */
const MAX_SESSION_SPAN_DAYS = 120;
const DEFAULT_BODY_LIMIT = 10;
const MAX_BODY_LIMIT = 50;

function clientFor(env: Env): GoogleHealthClient {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new ToolError(
      'Server misconfigured: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN must all be set. ' +
        'Run scripts/authorize.py, then push each with `wrangler secret put`.',
    );
  }
  return new GoogleHealthClient({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    ...(env.GOOGLE_TOKEN_URL ? { tokenUrl: env.GOOGLE_TOKEN_URL } : {}),
    ...(env.GOOGLE_API_BASE ? { apiBase: env.GOOGLE_API_BASE } : {}),
  });
}

function upstream(err: unknown): never {
  if (err instanceof GoogleHealthError) throw new ToolError(err.message);
  throw new ToolError(err instanceof Error ? err.message : String(err));
}

function requireDate(args: Record<string, unknown>, key: string): string {
  return realDate(args[key], key);
}

/** Optional date that clients may legitimately send as null. */
function optionalDate(args: Record<string, unknown>, key: string, fallback: string): string {
  const v = args[key];
  if (v === undefined || v === null || v === '') return fallback;
  return requireDate(args, key);
}

function optionalInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`Argument "${key}" must be a number.`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const shifted = new Date(d.getTime() + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function spanDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

/** Validate an inclusive range and enforce the per-tool span cap. */
function range(args: Record<string, unknown>, maxDays: number, label: string) {
  const start = requireDate(args, 'start_date');
  const end = optionalDate(args, 'end_date', start);
  if (Date.parse(`${end}T00:00:00Z`) < Date.parse(`${start}T00:00:00Z`)) {
    throw new ToolError(`end_date (${end}) is before start_date (${start}).`);
  }
  const days = spanDays(start, end);
  if (days > maxDays) {
    throw new ToolError(
      `That range covers ${days} days; ${label} allows at most ${maxDays} per call. ` +
        `Split it into several calls — any historical window works, the limit is only on how wide ` +
        `one call can be.`,
    );
  }
  // The API's upper bound is exclusive, the tool's is inclusive.
  return { start, end, days, endExclusive: addDays(end, 1) };
}

function fmtMinutes(mins: number | undefined): string {
  if (mins === undefined) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ── per-type reducers ────────────────────────────────────────────────────────

/** Google reconciles overlapping devices before calculating daily step totals. */
async function stepTotals(client: GoogleHealthClient, start: string, endExclusive: string) {
  const totals = new Map<string, number>();
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await client.aggregatePage('steps', { startDate: start, endDateExclusive: endExclusive,
      windowSizeDays: 1, pageSize: 100, pageToken });
    for (const point of page.points) {
      const day = civilDate(point.civilStartTime as never);
      const count = num(GoogleHealthClient.payload('steps', point).countSum);
      if (day && day >= start && day < endExclusive && count !== undefined) totals.set(day, count);
    }
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken && pages < 3);
  return { totals, truncated: !!pageToken };
}

interface SleepNight {
  date: string;
  bedtime?: string;
  wakeTime?: string;
  asleepMinutes?: number;
  awakeMinutes?: number;
  toFallAsleepMinutes?: number;
  inBedMinutes?: number;
  afterWakeUpMinutes?: number;
  stagesStatus?: unknown;
  processed?: unknown;
  stageMinutes: Record<string, number>;
  device?: string;
}

function readSleep(p: DataPoint): SleepNight | undefined {
  const payload = GoogleHealthClient.payload('sleep', p);
  const iv = payload.interval as Interval | undefined;
  // Filed by the date it ENDED — that is both what the API filters on and how a
  // night that starts after midnight should be labelled.
  const date = intervalLocalEndDate(iv);
  if (!date) return undefined;

  const summary = (payload.summary ?? {}) as Record<string, unknown>;
  const stageMinutes: Record<string, number> = {};
  const stages = Array.isArray(payload.stages) ? payload.stages : [];
  for (const s of stages) {
    const stage = s as { type?: unknown; startTime?: string; endTime?: string };
    const type = typeof stage.type === 'string' ? stage.type : 'UNKNOWN';
    const a = Date.parse(stage.startTime ?? '');
    const b = Date.parse(stage.endTime ?? '');
    if (Number.isNaN(a) || Number.isNaN(b) || b <= a) continue;
    stageMinutes[type] = (stageMinutes[type] ?? 0) + (b - a) / 60000;
  }

  const device = (p.dataSource?.device?.displayName ?? p.dataSource?.platform) as string | undefined;
  return {
    date,
    bedtime: localTimeOfDay(iv?.startTime, iv?.startUtcOffset),
    wakeTime: localTimeOfDay(iv?.endTime, iv?.endUtcOffset),
    asleepMinutes: num(summary.minutesAsleep),
    awakeMinutes: num(summary.minutesAwake),
    toFallAsleepMinutes: num(summary.minutesToFallAsleep),
    inBedMinutes: num(summary.minutesInSleepPeriod),
    afterWakeUpMinutes: num(summary.minutesAfterWakeUp),
    stagesStatus: (payload.metadata as Record<string, unknown> | undefined)?.stagesStatus,
    processed: (payload.metadata as Record<string, unknown> | undefined)?.processed,
    stageMinutes,
    ...(device ? { device } : {}),
  };
}

interface Workout {
  date: string;
  startTime?: string;
  type?: string;
  displayName?: string;
  activeMinutes?: number;
  calories?: number;
  distanceKm?: number;
  steps?: number;
  averageHeartRate?: number;
  activeZoneMinutes?: number;
  paceMinutesPerKm?: number;
  heartRateZoneMinutes?: Record<string, number>;
}

function readWorkout(p: DataPoint): Workout | undefined {
  const payload = GoogleHealthClient.payload('exercise', p);
  const iv = payload.interval as Interval | undefined;
  const date = intervalLocalStartDate(iv);
  if (!date) return undefined;
  const m = (payload.metricsSummary ?? {}) as Record<string, unknown>;
  const distanceMm = num(m.distanceMillimeters);
  const active = durationSeconds(payload.activeDuration);
  const pace = num(m.averagePaceSecondsPerMeter);
  const zones = m.heartRateZoneDurations as Record<string, unknown> | undefined;
  const zoneMinutes: Record<string, number> = {};
  for (const [key, value] of Object.entries(zones ?? {})) {
    const seconds = durationSeconds(value);
    if (seconds !== undefined) zoneMinutes[key] = seconds / 60;
  }
  return {
    date,
    startTime: localTimeOfDay(iv?.startTime, iv?.startUtcOffset),
    ...(typeof payload.exerciseType === 'string' ? { type: payload.exerciseType } : {}),
    ...(typeof payload.displayName === 'string' ? { displayName: payload.displayName } : {}),
    ...(active !== undefined ? { activeMinutes: Math.round(active / 60) } : {}),
    calories: num(m.caloriesKcal),
    ...(distanceMm !== undefined ? { distanceKm: distanceMm / 1_000_000 } : {}),
    steps: num(m.steps),
    averageHeartRate: num(m.averageHeartRateBeatsPerMinute),
    activeZoneMinutes: num(m.activeZoneMinutes),
    ...(pace !== undefined ? { paceMinutesPerKm: pace * 1000 / 60 } : {}),
    ...(Object.keys(zoneMinutes).length ? { heartRateZoneMinutes: zoneMinutes } : {}),
  };
}

/** Resting heart rate is a daily type keyed by a civil date object. */
function readRestingHeartRate(p: DataPoint): { date?: string; bpm?: number } {
  const payload = GoogleHealthClient.payload('daily-resting-heart-rate', p);
  return {
    date: civilDate(payload.date as never),
    bpm: num(payload.beatsPerMinute),
  };
}

/** Weight samples carry `sampleTime`; support both current physicalTime and legacy utcTime. */
function readWeight(p: DataPoint): { date?: string; kg?: number } {
  const payload = GoogleHealthClient.payload('weight', p);
  const grams = num(payload.weightGrams);
  const sample = payload.sampleTime as { civilTime?: never; utcTime?: string } | string | undefined;
  let date: string | undefined;
  if (typeof sample === 'string') date = sample.slice(0, 10);
  else if (sample && typeof sample === 'object') {
    date = civilDate((sample as Record<string, unknown>).civilTime as never)
      ?? localDate(
        ((sample as Record<string, unknown>).physicalTime ?? (sample as Record<string, unknown>).utcTime) as string | undefined,
        (sample as Record<string, unknown>).utcOffset,
      );
  }
  return { date, ...(grams !== undefined ? { kg: grams / 1000 } : {}) };
}

// ── tools ────────────────────────────────────────────────────────────────────

export function buildTools(env: Env, auth: ToolAuthorization = { scopes: new Set([HEALTH_READ_SCOPE]), resourceMetadataUrl: 'http://localhost/.well-known/oauth-protected-resource/mcp' }): Array<ToolDefinition<Env>> {
  const tools: Array<ToolDefinition<Env>> = [
    {
      name: 'get_health_summary',
      title: 'One day of health data',
      description:
        'Everything recorded for a single day: total steps, sleep (duration and stage breakdown), resting ' +
        'heart rate, latest weight, workouts, HRV, blood oxygen, respiratory rate, nightly temperature, VO2 max, active energy and zone minutes when available. Dates are local calendar dates, so "2026-07-24" means ' +
        'July 24 where the data was recorded. Sleep is filed under the day it ENDED, so a night starting ' +
        'late on the 23rd appears under the 24th. Any past date works — data going back years is available.',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The day to summarise, as YYYY-MM-DD (local date).' },
          include_extended: { type: ['boolean', 'null'], description: 'Include HRV, oxygen, respiration, nightly temperature, VO2 max, active energy and zone minutes. Default true.' },
        },
        required: ['date', 'include_extended'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const date = requireDate(args, 'date');
        const next = addDays(date, 1);
        const client = clientFor(ctx.env);

        try {
          if (args.include_extended != null && typeof args.include_extended !== 'boolean') throw new ToolError('include_extended must be a boolean.');
          const baseRange = { startDate: date, endDateExclusive: next, maxPages: 2 };
          const calls: Array<{ id: string; run: Promise<unknown> }> = [
            { id: 'steps', run: stepTotals(client, date, next) },
            { id: 'sleep', run: client.listDataPoints('sleep', baseRange) },
            { id: 'exercise', run: client.listDataPoints('exercise', baseRange) },
            { id: 'daily-resting-heart-rate', run: client.listDataPoints('daily-resting-heart-rate', baseRange) },
            { id: 'weight', run: client.listDataPoints('weight', { endDateExclusive: next, maxPages: 1 }) },
          ];
          const extraDaily = ['daily-heart-rate-variability', 'daily-oxygen-saturation',
            'daily-respiratory-rate', 'daily-sleep-temperature-derivations', 'daily-vo2-max'] as const;
          if (args.include_extended !== false) {
            for (const type of extraDaily) calls.push({ id: type, run: client.listDataPoints(type, baseRange) });
            for (const type of ['active-energy-burned', 'active-zone-minutes'] as const) {
              calls.push({ id: type, run: client.aggregatePage(type, { startDate: date, endDateExclusive: next, windowSizeDays: 1, pageSize: 100 }) });
            }
          }
          const results = await Promise.allSettled(calls.map(c => c.run));
          const errors: Record<string, string> = {};
          const incomplete: string[] = [];
          const collected: Record<string, { points: DataPoint[] }> = {};
          let steps: number | undefined;
          for (let i = 0; i < calls.length; i++) {
            const result = results[i]!;
            const id = calls[i]!.id;
            if (result.status === 'rejected') {
              errors[id] = result.reason instanceof Error ? result.reason.message : String(result.reason);
              continue;
            }
            if (id === 'steps') {
              const value = result.value as Awaited<ReturnType<typeof stepTotals>>;
              steps = value.totals.get(date);
              if (value.truncated) incomplete.push(id);
            } else {
              const value = result.value as { points: DataPoint[]; truncated?: boolean; nextPageToken?: string };
              collected[id] = value;
              if ((id !== 'weight' && value.truncated) || value.nextPageToken) incomplete.push(id);
            }
          }
          if (results.every(r => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
          const nights = (collected.sleep?.points ?? []).map(readSleep).filter((n): n is SleepNight => !!n);
          const workouts = (collected.exercise?.points ?? []).map(readWorkout).filter((w): w is Workout => !!w);
          const rhr = (collected['daily-resting-heart-rate']?.points ?? []).map(readRestingHeartRate).find(r => r.date === date);
          const weight = (collected.weight?.points ?? []).map(readWeight)
            .filter(w => w.date && w.date <= date && w.kg !== undefined)
            .sort((a, b) => b.date!.localeCompare(a.date!))[0];
          const extended: Record<string, unknown[]> = {};
          if (args.include_extended !== false) {
            for (const type of [...extraDaily, 'active-energy-burned', 'active-zone-minutes'] as const) {
              extended[type] = (collected[type]?.points ?? []).map(p => GoogleHealthClient.payload(type, p));
            }
          }

          const lines: string[] = [`# ${date}`, ''];
          lines.push(`**Steps:** ${steps !== undefined ? steps.toLocaleString('en-US') : errors.steps ? 'lookup failed' : 'no data'}`);
          if (rhr?.bpm !== undefined) lines.push(`**Resting heart rate:** ${rhr.bpm} bpm`);
          if (weight?.kg !== undefined) {
            lines.push(
              `**Weight:** ${weight.kg.toFixed(1)} kg` +
                (weight.date !== date ? ` (last measured ${weight.date})` : ''),
            );
          }

          if (nights.length) {
            lines.push('', '## Sleep');
            for (const n of nights) {
              lines.push(
                `- ${fmtMinutes(n.asleepMinutes)} asleep` +
                  (n.bedtime && n.wakeTime ? ` (${n.bedtime} → ${n.wakeTime})` : ''),
              );
              const stages = Object.entries(n.stageMinutes).sort((a, b) => b[1] - a[1]);
              if (stages.length) {
                lines.push(`  stages: ${stages.map(([k, v]) => `${k} ${fmtMinutes(v)}`).join(', ')}`);
              }
              if (n.toFallAsleepMinutes !== undefined) {
                lines.push(`  fell asleep in ${fmtMinutes(n.toFallAsleepMinutes)}, awake ${fmtMinutes(n.awakeMinutes)}`);
              }
            }
          } else {
            lines.push('', '## Sleep', errors.sleep ? '- sleep lookup failed; see partial errors below' : '- no sleep recorded for this date');
          }

          if (workouts.length) {
            lines.push('', '## Workouts');
            for (const w of workouts) lines.push(`- ${describeWorkout(w)}`);
          }

          const presentExtra = Object.entries(extended).filter(([, values]) => values.length);
          if (presentExtra.length) {
            lines.push('', '## Additional metrics', ...presentExtra.map(([id, values]) => `- ${id}: ${JSON.stringify(values)}`));
          }
          if (Object.keys(errors).length) lines.push('', 'Partial result — failed metrics:', ...Object.entries(errors).map(([id, error]) => `- ${id}: ${error}`));
          if (incomplete.length) lines.push('', `Incomplete metrics: ${incomplete.join(', ')}. Use query_health_data to page through the remainder.`);
          return {
            text: lines.join('\n'),
            structured: {
              date,
              steps: steps ?? null,
              resting_heart_rate_bpm: rhr?.bpm ?? null,
              weight_kg: weight?.kg ?? null,
              weight_measured_date: weight?.date ?? null,
              extended_metrics: extended,
              errors,
              incomplete_metrics: incomplete,
              truncated: incomplete.length > 0,
              sleep_minutes_asleep: nights[0]?.asleepMinutes ?? null,
              workout_count: workouts.length,
            },
          };
        } catch (err) {
          upstream(err);
        }
      },
    },

    {
      name: 'get_steps_by_day',
      title: 'Daily step totals',
      description:
        `Total steps for each day in a date range, plus the average. At most ${MAX_STEP_SPAN_DAYS} days per ` +
        'call. Google aggregates a reconciled stream, merging overlapping phone/watch records before summing. ' +
        'The limit is on the WIDTH of one call, not on how far back it reaches: any historical ' +
        'window works, and years of history are available. For a longer period, make several calls.',
      inputSchema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'First day, YYYY-MM-DD (local date).' },
          end_date: {
            type: ['string', 'null'],
            description: `Last day, inclusive, YYYY-MM-DD. Pass null for a single day. Max ${MAX_STEP_SPAN_DAYS} days total.`,
          },
        },
        required: ['start_date', 'end_date'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const r = range(args, MAX_STEP_SPAN_DAYS, 'get_steps_by_day');
        let res;
        try {
          res = await stepTotals(clientFor(ctx.env), r.start, r.endExclusive);
        } catch (err) { upstream(err); }
        const days: Array<{ date: string; steps: number | null }> = [];
        for (let i = 0; i < r.days; i++) {
          const date = addDays(r.start, i);
          days.push({ date, steps: res.totals.get(date) ?? null });
        }
        const withData = days.filter((d): d is { date: string; steps: number } => d.steps !== null);
        const total = withData.reduce((a, d) => a + d.steps, 0);
        const avg = withData.length ? Math.round(total / withData.length) : null;

        const lines = [
          `# Steps, ${r.start} → ${r.end}`,
          '',
          ...days.map((d) => `- ${d.date}  ${d.steps !== null ? d.steps.toLocaleString('en-US') : 'no data'}`),
          '',
          `**Total:** ${total.toLocaleString('en-US')} over ${withData.length} day(s) with data`,
          `**Daily average:** ${avg === null ? 'no data' : avg.toLocaleString('en-US')}`,
        ];
        if (res.truncated) {
          lines.push('', '> Note: hit the pagination cap, so the earliest days may be incomplete. Try a narrower range.');
        }

        return {
          text: lines.join('\n'),
          structured: {
            start_date: r.start,
            end_date: r.end,
            days: days.map((d) => ({ date: d.date, steps: d.steps })),
            total_steps: withData.length ? total : null,
            reconciled: true,
            days_with_data: withData.length,
            daily_average: avg,
            truncated: res.truncated,
          },
        };
      },
    },

    {
      name: 'get_sleep',
      title: 'Sleep sessions',
      description:
        'Sleep for each night in a date range: time asleep, bedtime and wake time, how long it took to fall ' +
        'asleep, and minutes in each stage (AWAKE / LIGHT / DEEP / REM). Each night is filed under the date it ' +
        `ENDED, so ask for the morning you woke up. Up to ${MAX_SESSION_SPAN_DAYS} days per call — sleep is one ` +
        'pre-summarised record per night, so wide ranges are cheap.',
      inputSchema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'First wake-up date, YYYY-MM-DD (local date).' },
          end_date: {
            type: ['string', 'null'],
            description: 'Last wake-up date, inclusive. Pass null for a single night.',
          },
        },
        required: ['start_date', 'end_date'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const r = range(args, MAX_SESSION_SPAN_DAYS, 'get_sleep');
        let res;
        try {
          res = await clientFor(ctx.env).listDataPoints('sleep', {
            startDate: r.start,
            endDateExclusive: r.endExclusive,
          });
        } catch (err) {
          upstream(err);
        }
        const nights = res.points
          .map(readSleep)
          .filter((n): n is SleepNight => !!n)
          .sort((a, b) => a.date.localeCompare(b.date));

        if (!nights.length) {
          return {
            text: `No sleep recorded between ${r.start} and ${r.end}. Remember sleep is filed by the date you woke up.`,
            structured: { start_date: r.start, end_date: r.end, nights: [], truncated: res.truncated },
          };
        }

        const asleep = nights.map((n) => n.asleepMinutes).filter((m): m is number => m !== undefined);
        const avg = asleep.length ? asleep.reduce((a, b) => a + b, 0) / asleep.length : undefined;

        const lines = [`# Sleep, ${r.start} → ${r.end}`, ''];
        for (const n of nights) {
          lines.push(
            `## ${n.date}` + (n.device ? `  ·  ${n.device}` : ''),
            `- asleep **${fmtMinutes(n.asleepMinutes)}**` +
              (n.bedtime && n.wakeTime ? `, ${n.bedtime} → ${n.wakeTime}` : ''),
          );
          const stages = Object.entries(n.stageMinutes).sort((a, b) => b[1] - a[1]);
          if (stages.length) lines.push(`- stages: ${stages.map(([k, v]) => `${k} ${fmtMinutes(v)}`).join(', ')}`);
          if (n.toFallAsleepMinutes !== undefined || n.awakeMinutes !== undefined) {
            lines.push(`- to fall asleep ${fmtMinutes(n.toFallAsleepMinutes)}, awake ${fmtMinutes(n.awakeMinutes)}`);
          }
          lines.push('');
        }
        if (avg !== undefined) lines.push(`**Average time asleep:** ${fmtMinutes(avg)} over ${nights.length} night(s)`);
        if (res.truncated) lines.push('Incomplete result: pagination cap reached. Use query_health_data for resumable pages.');

        return {
          text: lines.join('\n'),
          structured: {
            start_date: r.start,
            end_date: r.end,
            nights: nights.map((n) => ({
              date: n.date,
              minutes_asleep: n.asleepMinutes ?? null,
              minutes_awake: n.awakeMinutes ?? null,
              minutes_to_fall_asleep: n.toFallAsleepMinutes ?? null,
              minutes_in_bed: n.inBedMinutes ?? null,
              minutes_after_wake_up: n.afterWakeUpMinutes ?? null,
              stages_status: n.stagesStatus ?? null,
              processed: n.processed ?? null,
              device: n.device ?? null,
              bedtime: n.bedtime ?? null,
              wake_time: n.wakeTime ?? null,
              stage_minutes: n.stageMinutes,
            })),
            average_minutes_asleep: avg !== undefined ? Math.round(avg) : null,
            truncated: res.truncated,
          },
        };
      },
    },

    {
      name: 'get_workouts',
      title: 'Workouts and exercise',
      description:
        'Individual exercise sessions in a date range — type, duration, calories, distance, steps, average ' +
        'heart rate and active zone minutes. One record per workout, pre-summarised by the API, so up to ' +
        `${MAX_SESSION_SPAN_DAYS} days per call.`,
      inputSchema: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'First day, YYYY-MM-DD (local date).' },
          end_date: { type: ['string', 'null'], description: 'Last day, inclusive. Pass null for a single day.' },
        },
        required: ['start_date', 'end_date'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const r = range(args, MAX_SESSION_SPAN_DAYS, 'get_workouts');
        let res;
        try {
          res = await clientFor(ctx.env).listDataPoints('exercise', {
            startDate: r.start,
            endDateExclusive: r.endExclusive,
          });
        } catch (err) {
          upstream(err);
        }
        const workouts = res.points
          .map(readWorkout)
          .filter((w): w is Workout => !!w)
          .sort((a, b) => (a.date + (a.startTime ?? '')).localeCompare(b.date + (b.startTime ?? '')));

        if (!workouts.length) {
          return {
            text: `No workouts recorded between ${r.start} and ${r.end}.`,
            structured: { start_date: r.start, end_date: r.end, workouts: [], truncated: res.truncated },
          };
        }

        const totalMin = workouts.reduce((a, w) => a + (w.activeMinutes ?? 0), 0);
        const lines = [
          `# Workouts, ${r.start} → ${r.end}`,
          '',
          ...workouts.map((w) => `- **${w.date}** ${describeWorkout(w)}`),
          '',
          `**${workouts.length} session(s), ${fmtMinutes(totalMin)} active in total**`,
        ];

        if (res.truncated) lines.push('Incomplete result: pagination cap reached. Use query_health_data for resumable pages.');
        return {
          text: lines.join('\n'),
          structured: {
            start_date: r.start,
            end_date: r.end,
            workouts: workouts.map((w) => ({
              date: w.date,
              start_time: w.startTime ?? null,
              type: w.type ?? null,
              display_name: w.displayName ?? null,
              active_minutes: w.activeMinutes ?? null,
              calories_kcal: w.calories ?? null,
              distance_km: w.distanceKm !== undefined ? Number(w.distanceKm.toFixed(2)) : null,
              steps: w.steps ?? null,
              average_heart_rate_bpm: w.averageHeartRate ?? null,
              active_zone_minutes: w.activeZoneMinutes ?? null,
              average_pace_minutes_per_km: w.paceMinutesPerKm ?? null,
              heart_rate_zone_minutes: w.heartRateZoneMinutes ?? null,
            })),
            total_active_minutes: totalMin,
            truncated: res.truncated,
          },
        };
      },
    },

    {
      name: 'get_body_metrics',
      title: 'Recent weight measurements',
      description:
        'The most recent weight measurements, newest first. This one takes a count rather than a date range: ' +
        'use query_health_data with data_type=weight when you need a date range or pagination. ' +
        'Use this convenience tool for current weight and short-term trend.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: ['integer', 'null'],
            description: `How many measurements to return, 1-${MAX_BODY_LIMIT}. Pass null for ${DEFAULT_BODY_LIMIT}.`,
          },
        },
        required: ['limit'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(args, ctx) {
        const limit = optionalInt(args, 'limit', DEFAULT_BODY_LIMIT, 1, MAX_BODY_LIMIT);
        let res;
        try {
          // Newest-first, and MAX_BODY_LIMIT is far below one page.
          res = await clientFor(ctx.env).listDataPoints('weight', { maxPages: 1 });
        } catch (err) {
          upstream(err);
        }
        const all = res.points.map(readWeight).filter((w) => w.kg !== undefined);
        const rows = all.slice(0, limit);

        if (!rows.length) {
          return {
            text: 'No weight measurements found.',
            structured: { measurements: [] },
          };
        }
        const first = rows[0]!.kg!;
        const last = rows[rows.length - 1]!.kg!;
        const lines = [
          '# Weight',
          '',
          ...rows.map((w) => `- ${w.date ?? 'unknown date'}  ${w.kg!.toFixed(1)} kg`),
        ];
        if (rows.length > 1) {
          const delta = first - last;
          lines.push('', `**Change across these ${rows.length} readings:** ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} kg`);
        }
        return {
          text: lines.join('\n'),
          structured: {
            measurements: rows.map((w) => ({ date: w.date ?? null, weight_kg: Number(w.kg!.toFixed(2)) })),
            latest_kg: Number(first.toFixed(2)),
          },
        };
      },
    },
  ];

  tools.push(...buildQueryTools<Env>(clientFor));

  if (env.DEBUG_TOOLS === '1') {
    tools.push({
      name: 'health_diagnostics',
      title: 'Diagnostic: connectivity',
      description:
        'Diagnostic only. Verifies the OAuth refresh works and reports which data types return data, with ' +
        'point counts. Use this when health lookups start failing to tell an auth problem from a data gap.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      async handler(_args, ctx) {
        const client = clientFor(ctx.env);
        const types = ['steps', 'sleep', 'exercise', 'weight', 'daily-resting-heart-rate'] as const;
        const lines: string[] = [];
        for (const t of types) {
          const t0 = Date.now();
          try {
            // One page only. Unfiltered enumeration of steps took 90+ seconds.
            const r = await client.listDataPoints(t, { maxPages: 1 });
            lines.push(`${t}: ok — ${r.points.length} point(s) on the first ${r.pages} page(s), ${Date.now() - t0}ms` +
              (GoogleHealthClient.filterable(t) ? '' : ' (not filterable server-side)'));
          } catch (err) {
            lines.push(`${t}: FAILED (${Date.now() - t0}ms) — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { text: lines.join('\n') };
      },
    });
  }

  tools.push(...buildFeatureTools(clientFor));
  if (env.ENABLE_WRITES === '1') tools.push(...buildWriteTools(clientFor));
  return tools.map((tool) => ({
    ...tool,
    securitySchemes: [{ type: 'oauth2', scopes: [tool.annotations?.readOnlyHint === false ? HEALTH_WRITE_SCOPE : HEALTH_READ_SCOPE] }],
    async handler(args, ctx) {
      const required = tool.annotations?.readOnlyHint === false ? HEALTH_WRITE_SCOPE : HEALTH_READ_SCOPE;
      if (!auth.scopes.has(required)) {
        throw new ToolError(`Re-authorize this client with ${required} permission.`,
          { required_scope: required },
          { 'mcp/www_authenticate': `Bearer resource_metadata="${auth.resourceMetadataUrl}", error="insufficient_scope", scope="${required}"` });
      }
      return tool.handler(args, ctx);
    },
  }));
}

function describeWorkout(w: Workout): string {
  const bits = [w.displayName || w.type || 'workout'];
  if (w.startTime) bits.push(`at ${w.startTime}`);
  if (w.activeMinutes !== undefined) bits.push(fmtMinutes(w.activeMinutes));
  if (w.distanceKm !== undefined && w.distanceKm > 0) bits.push(`${w.distanceKm.toFixed(2)} km`);
  if (w.calories !== undefined) bits.push(`${w.calories} kcal`);
  if (w.averageHeartRate !== undefined) bits.push(`avg ${w.averageHeartRate} bpm`);
  if (w.activeZoneMinutes !== undefined) bits.push(`${w.activeZoneMinutes} AZM`);
  if (w.paceMinutesPerKm !== undefined) bits.push(`${w.paceMinutesPerKm.toFixed(2)} min/km`);
  return bits.join(' · ');
}

export const SERVER_INSTRUCTIONS =
  'Uses the user\'s own Google Health data. Optional writes require health:write, deployment enablement and user confirmation. All date-only arguments are LOCAL calendar dates; sleep is filed under the date it ENDED. ' +
  'Start with get_health_summary for one day, including HRV, blood oxygen, respiration, nightly temperature, VO2 max and activity metrics when available. ' +
  'get_steps_by_day uses Google reconciled aggregation and accepts up to 90 days. get_sleep/get_workouts accept 120 days. ' +
  'Use list_health_data_types to discover supported metrics and operations, query_health_data for raw or reconciled pages and exact time windows, ' +
  'and aggregate_health_data for daily, multi-day, hourly or minute-level summaries with optional data-source selection. ' +
  'Use get_health_report for weekly/monthly trends and sleep regularity; get_workout_details for splits, export_workout_tcx for TCX, get_health_devices for sync status. Nutrition, ECG, IRN, devices, account and location exports require additional Google scopes. ' +
  'Resume next_page_token with all other arguments identical. Most aggregate types allow 90 days; heart rate/active minutes/total calories/calories in HR zones allow 14. ' +
  'skin-temperature-sensors uses v4beta, raw sensorData must not be interpreted as clinical body temperature. ' +
  'Native API numeric strings and units are preserved in flexible queries. Empty records or null values mean unavailable data, not zero. ' +
  'Report partial errors or truncated results explicitly. Limits constrain the width of one query, not how far back you can look. Any historical period works within the per-call range limits.';
