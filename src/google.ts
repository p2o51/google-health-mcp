/** Google Health REST client. Numeric fields may be numbers or int64 strings. */
import { DATA_TYPES } from './catalog.ts';
import type { DataType, SourceFamily } from './catalog.ts';
export type { DataType, SourceFamily } from './catalog.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://health.googleapis.com/v4';

/**
 * Requested page size. The server caps actual pages far below this — measured at
 * roughly 335 items regardless of asking for 1000 — so page counts must be
 * derived from observation, not from this number.
 */
const PAGE_SIZE = 1000;

/** Hard stop on pagination, well inside the 50-subrequest-per-invocation limit. */
const MAX_PAGES = 40;

export class GoogleHealthError extends Error {
  readonly status?: number;
  readonly reason?: string;
  /** True when the request never got a response — always worth retrying. */
  network = false;

  constructor(message: string, status?: number, reason?: string) {
    super(message);
    this.name = 'GoogleHealthError';
    this.status = status;
    this.reason = reason;
  }
}

/** One client is scoped to one MCP invocation, including its refresh exchange. */
const MAX_REQUESTS = 45;

export interface PageOptions {
  startDate?: string;
  endDateExclusive?: string;
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  pageToken?: string;
  sourceFamily?: SourceFamily;
  reconcile?: boolean;
}

export interface AggregateOptions extends Omit<PageOptions, 'reconcile'> {
  windowSizeDays?: number;
  windowSeconds?: number;
}

export interface DataPage {
  points: DataPoint[];
  nextPageToken?: string;
}

export interface DataPoint {
  name?: string;
  dataSource?: {
    recordingMethod?: string;
    platform?: string;
    device?: { formFactor?: string; manufacturer?: string; displayName?: string };
    application?: { packageName?: string };
  };
  [payload: string]: unknown;
}

export interface Interval {
  startTime?: string;
  endTime?: string;
  startUtcOffset?: string;
  endUtcOffset?: string;
  civilStartTime?: CivilDateTime;
  civilEndTime?: CivilDateTime;
}

export interface CivilDateTime {
  date?: { year?: unknown; month?: unknown; day?: unknown };
  time?: { hours?: unknown; minutes?: unknown; seconds?: unknown };
}

// ── value coercion ───────────────────────────────────────────────────────────

/** Accept protobuf doubles and int64 strings. Returns undefined rather than NaN. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a protobuf duration string: "32400s", "1161.600s" → seconds. */
export function durationSeconds(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(v.trim());
  return m?.[1] ? Number(m[1]) : num(v);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Render a civil date as YYYY-MM-DD.
 *
 * Accepts both shapes the API uses: a CivilDateTime wrapper (`{date: {...},
 * time: {...}}`, as on step intervals) and a bare date object (`{year, month,
 * day}`, as on daily-* types like resting heart rate). Handling only the wrapper
 * silently returned undefined for every daily type.
 */
export function civilDate(
  c: CivilDateTime | { year?: unknown; month?: unknown; day?: unknown } | undefined,
): string | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const wrapped = (c as CivilDateTime).date;
  const d = (wrapped && typeof wrapped === 'object' ? wrapped : c) as {
    year?: unknown;
    month?: unknown;
    day?: unknown;
  };
  const y = num(d.year);
  const m = num(d.month);
  const day = num(d.day);
  if (y === undefined || m === undefined || day === undefined) return undefined;
  return `${y}-${pad(m)}-${pad(day)}`;
}

/**
 * The local calendar date an instant fell on, in the timezone the data was
 * recorded in.
 *
 * This matters more than it looks: a sleep session starting 2026-07-24T16:54Z
 * with a +32400s offset actually began at 01:54 on July 25 locally. Grouping by
 * the UTC date would file a large share of nights under the wrong day.
 */
export function localDate(isoUtc: string | undefined, utcOffset: unknown): string | undefined {
  if (!isoUtc) return undefined;
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return undefined;
  const offsetSec = durationSeconds(utcOffset) ?? 0;
  const shifted = new Date(ms + offsetSec * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Local date for an interval, preferring the civil time when the API supplies it. */
export function intervalLocalStartDate(iv: Interval | undefined): string | undefined {
  return civilDate(iv?.civilStartTime) ?? localDate(iv?.startTime, iv?.startUtcOffset);
}

export function intervalLocalEndDate(iv: Interval | undefined): string | undefined {
  return civilDate(iv?.civilEndTime) ?? localDate(iv?.endTime, iv?.endUtcOffset);
}

/** Local wall-clock HH:MM for display. */
export function localTimeOfDay(isoUtc: string | undefined, utcOffset: unknown): string | undefined {
  if (!isoUtc) return undefined;
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) return undefined;
  const shifted = new Date(ms + (durationSeconds(utcOffset) ?? 0) * 1000);
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

// ── client ───────────────────────────────────────────────────────────────────

export interface GoogleHealthClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  timeoutMs?: number;
  tokenUrl?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class GoogleHealthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly timeoutMs: number;
  private readonly tokenUrl: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  /**
   * The in-flight or completed token exchange, cached for the lifetime of one
   * client instance.
   *
   * A PROMISE, not the resolved string: get_health_summary fires five fetches
   * with Promise.all, and caching only the resolved value meant all five saw an
   * empty cache and each ran its own exchange — five redundant subrequests and
   * five round trips of latency per call. Sharing the promise collapses them.
   *
   * Deliberately not module scope: isolates are recycled unpredictably, and
   * caching a credential across requests is not something to do by accident.
   */
  private tokenPromise?: Promise<string>;
  private requestCount = 0;
  private grantedScopes: string[] | null = null;

  constructor(opts: GoogleHealthClientOptions) {
    if (!opts.clientId || !opts.clientSecret || !opts.refreshToken) {
      throw new Error('GoogleHealthClient: clientId, clientSecret and refreshToken are all required');
    }
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.refreshToken = opts.refreshToken;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.tokenUrl = opts.tokenUrl ?? TOKEN_URL;
    this.apiBase = (opts.apiBase ?? API_BASE).replace(/\/+$/, '');
    // Must be bound: calling the global through a property passes this client as
    // `this`, which workerd rejects with "Illegal invocation".
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private redact(message: string, accessToken?: string): string {
    let safe = message;
    for (const secret of [accessToken, this.clientSecret, this.refreshToken]) {
      if (secret) safe = safe.replaceAll(secret, '[redacted]');
    }
    return safe;
  }

  /** Exchange the refresh token for an access token (~1 hour lifetime). */
  private getAccessToken(): Promise<string> {
    if (!this.tokenPromise) {
      // On failure, clear the cache so a later call can retry rather than
      // replaying the same rejection forever.
      this.tokenPromise = this.exchangeRefreshToken().catch((err) => {
        this.tokenPromise = undefined;
        throw err;
      });
    }
    return this.tokenPromise;
  }

  private async exchangeRefreshToken(): Promise<string> {
    this.reserveRequest();
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });

    let text: string;
    let status: number;
    try {
      const res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const e = new GoogleHealthError(
        this.redact(`could not reach Google's token endpoint: ${err instanceof Error ? err.message : String(err)}`),
      );
      e.network = true;
      throw e;
    }

    let parsed: { access_token?: string; scope?: string; error?: string; error_description?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GoogleHealthError(`token endpoint returned non-JSON (HTTP ${status})`, status);
    }

    if (!parsed.access_token) {
      // invalid_grant is the one worth naming: it means the refresh token was
      // revoked or expired, and only a fresh browser consent can fix it.
      throw new GoogleHealthError(
        parsed.error === 'invalid_grant'
          ? 'Google rejected the refresh token (invalid_grant). It was most likely revoked at ' +
            'myaccount.google.com/permissions, or the OAuth consent screen is still in "Testing" ' +
            'status so the token expired after 7 days. Re-run scripts/authorize.py to get a new one.'
          : `token exchange failed (HTTP ${status}): ${this.redact(parsed.error ?? 'unknown')}` +
            (parsed.error_description ? ` — ${this.redact(parsed.error_description)}` : ''),
        status,
        parsed.error,
      );
    }
    this.grantedScopes = typeof parsed.scope === 'string' ? parsed.scope.split(' ') : null;
    return parsed.access_token;
  }

  private reserveRequest(): void {
    if (this.requestCount >= MAX_REQUESTS) {
      throw new GoogleHealthError(
        'This query reached its 45-request budget. Continue using the returned page token or choose a shorter range.',
        undefined,
        'REQUEST_BUDGET_EXCEEDED',
      );
    }
    this.requestCount++;
  }

  private async apiRequest(
    type: DataType,
    suffix: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    this.reserveRequest();
    const version = DATA_TYPES[type].version;
    // Preserve caller-supplied mock origins. A versioned base opts into version
    // substitution; an unversioned base stays exactly as supplied for every type.
    const base = this.apiBase.replace(/\/v4(?:beta)?$/, `/${version}`);
    const query = new URLSearchParams(params).toString();
    const url = `${base}/users/me/dataTypes/${type}/dataPoints${suffix}${query ? `?${query}` : ''}`;

    let text: string;
    let status: number;
    try {
      const res = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const e = new GoogleHealthError(
        this.redact(`could not reach the Google Health API: ${err instanceof Error ? err.message : String(err)}`, token),
      );
      e.network = true;
      throw e;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GoogleHealthError(
        `Google Health API returned a non-JSON response (HTTP ${status}) — check the data type name`,
        status,
      );
    }
    if (status < 200 || status >= 300) {
      // An upstream diagnostic must never echo an opaque credential to a tool.
      throw new GoogleHealthError(this.redact(describeApiError(parsed, status), token), status);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new GoogleHealthError('Google Health API returned an invalid JSON object', status);
    }
    return parsed as Record<string, unknown>;
  }

  async authorizationStatus(): Promise<{ granted_scopes: string[] | null }> {
    await this.getAccessToken();
    return { granted_scopes: this.grantedScopes };
  }

  /** Internal relative routes only. Callers cannot select a host or an account. */
  private async resourceRequest(path: string, params: Record<string, string> = {}, body?: Record<string, unknown>, media = false): Promise<any> {
    const token = await this.getAccessToken();
    this.reserveRequest();
    const url = `${this.apiBase}/${path}?${new URLSearchParams(params)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Accept: media ? 'application/xml' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) { throw new GoogleHealthError(this.redact(`Google Health request failed: ${error instanceof Error ? error.message : String(error)}`, token)); }
    const text = await response.text();
    if (!response.ok) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      throw new GoogleHealthError(this.redact(describeApiError(parsed, response.status), token), response.status);
    }
    if (media) {
      if (text.length > 1_000_000) throw new GoogleHealthError('TCX exceeds the 1 MB response limit. Export a shorter workout.');
      if (!/<(?:[A-Za-z_][\w.-]*:)?TrainingCenterDatabase(?:\s|>)/.test(text)) throw new GoogleHealthError('Google returned an invalid TCX document.');
      return text;
    }
    try { return JSON.parse(text); } catch { throw new GoogleHealthError('Google Health returned invalid JSON'); }
  }

  async accountResource(resource: 'identity' | 'profile' | 'settings' | 'irnProfile'): Promise<Record<string, any>> {
    if (!['identity', 'profile', 'settings', 'irnProfile'].includes(resource)) throw new GoogleHealthError('Invalid account resource');
    return this.resourceRequest(`users/me/${resource}`);
  }

  async pairedDevices(pageToken?: string): Promise<Record<string, any>> {
    return this.resourceRequest('users/me/pairedDevices', { pageSize: '100', ...(pageToken ? { pageToken } : {}) });
  }

  private recordId(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new GoogleHealthError('record_id must be a single opaque ID, not a URL or resource path.');
    return id;
  }

  async workout(id: string): Promise<Record<string, any>> {
    return this.resourceRequest(`users/me/dataTypes/exercise/dataPoints/${this.recordId(id)}`);
  }

  async exportWorkout(id: string, partialData: boolean): Promise<string> {
    return this.resourceRequest(`users/me/dataTypes/exercise/dataPoints/${this.recordId(id)}:exportExerciseTcx`, { alt: 'media', partialData: String(partialData) }, undefined, true);
  }

  async createRecord(type: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const keys: Record<string, string> = { 'hydration-log': 'hydrationLog', 'nutrition-log': 'nutritionLog', moods: 'moods', symptoms: 'symptoms', 'menstrual-period': 'menstrualPeriod' };
    const key = keys[type];
    if (!key) throw new GoogleHealthError('Unsupported writable data type');
    // No automatic retries: a timeout can mean the write succeeded upstream.
    return this.resourceRequest(`users/me/dataTypes/${type}/dataPoints`, {}, { [key]: payload });
  }

  /** Read exactly one raw or reconciled page; retain the continuation token. */
  async listPage(type: DataType, options: PageOptions = {}): Promise<DataPage> {
    const spec = DATA_TYPES[type];
    const reconciled = options.reconcile ?? false;
    if (!(reconciled ? spec.reconcile : spec.list)) {
      throw new GoogleHealthError(`${type} does not support ${reconciled ? 'reconcile' : 'list'} reads`);
    }
    if (type === 'sleep' && options.sourceFamily && !reconciled) {
      throw new GoogleHealthError('Filtering sleep by data source requires a reconciled read');
    }
    const physical = options.startTime !== undefined || options.endTime !== undefined;
    const field = physical ? spec.filterField.physical : spec.filterField.civil;
    if (!field && (options.startTime || options.endTime || options.startDate || options.endDateExclusive)) {
      throw new GoogleHealthError(`${type} does not support this date/time filter; use a supported filter or an unfiltered page.`);
    }
    const start = physical ? options.startTime : options.startDate;
    const end = physical ? options.endTime : options.endDateExclusive;
    const clauses: string[] = [];
    if (start !== undefined) clauses.push(`${field} >= ${JSON.stringify(start)}`);
    if (end !== undefined) clauses.push(`${field} < ${JSON.stringify(end)}`);
    const params: Record<string, string> = {
      pageSize: String(Math.min(options.pageSize ?? PAGE_SIZE, spec.maxPageSize)),
    };
    if (clauses.length) params.filter = clauses.join(' AND ');
    if (options.pageToken) params.pageToken = options.pageToken;
    if (options.sourceFamily) params.dataSourceFamily = `users/me/dataSourceFamilies/${options.sourceFamily}`;
    const response = await this.apiRequest(type, reconciled ? ':reconcile' : '', params);
    return {
      points: Array.isArray(response.dataPoints) ? response.dataPoints as DataPoint[] : [],
      ...(typeof response.nextPageToken === 'string' && response.nextPageToken
        ? { nextPageToken: response.nextPageToken } : {}),
    };
  }

  /** Read one daily civil-time or fixed-duration physical-time aggregation page. */
  async aggregatePage(type: DataType, options: AggregateOptions): Promise<DataPage> {
    const spec = DATA_TYPES[type];
    const physical = options.startTime !== undefined || options.endTime !== undefined || options.windowSeconds !== undefined;
    if (!(physical ? spec.rollup : spec.dailyRollup)) {
      throw new GoogleHealthError(`${type} does not support ${physical ? 'physical' : 'daily'} aggregation`);
    }
    const body: Record<string, unknown> = physical
      ? {
        range: { startTime: options.startTime, endTime: options.endTime },
        windowSize: `${options.windowSeconds}s`,
      }
      : {
        range: {
          start: dateAtMidnight(options.startDate),
          end: dateAtMidnight(options.endDateExclusive),
        },
        windowSizeDays: options.windowSizeDays ?? 1,
      };
    if (options.pageSize !== undefined) body.pageSize = options.pageSize;
    if (options.pageToken) body.pageToken = options.pageToken;
    if (options.sourceFamily) body.dataSourceFamily = `users/me/dataSourceFamilies/${options.sourceFamily}`;
    const response = await this.apiRequest(type, physical ? ':rollUp' : ':dailyRollUp', {}, body);
    return {
      points: Array.isArray(response.rollupDataPoints) ? response.rollupDataPoints as DataPoint[] : [],
      ...(typeof response.nextPageToken === 'string' && response.nextPageToken
        ? { nextPageToken: response.nextPageToken } : {}),
    };
  }

  /**
   * Fetch every data point of one type within an inclusive civil-date range,
   * following pagination.
   *
   * `onPage` is invoked per page so the caller can reduce and discard as it
   * goes. Holding every point at once is what would put the free plan's 10ms CPU
   * budget at risk: a single month of steps is ~7,300 points.
   */
  async listDataPoints(
    type: DataType,
    range: { startDate?: string; endDateExclusive?: string; maxPages?: number } = {},
    onPage?: (points: DataPoint[]) => void,
  ): Promise<{ points: DataPoint[]; pages: number; truncated: boolean }> {
    // Unfiltered reads walk the ENTIRE history, which for steps is years of
    // sub-second fragments. Callers that only want "the newest few" must cap
    // this — results come back newest-first, so one page is usually enough.
    // Discovered the hard way: an uncapped unfiltered diagnostic ran 90+ seconds
    // and would have blown the subrequest limit.
    const pageCap = Math.max(1, Math.min(range.maxPages ?? MAX_PAGES, MAX_PAGES));
    const collected: DataPoint[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    for (;;) {
      const page = await this.listPage(type, {
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
        pageToken,
      });
      pages++;
      if (onPage) onPage(page.points);
      else collected.push(...page.points);
      pageToken = page.nextPageToken;
      if (!pageToken) return { points: collected, pages, truncated: false };
      if (pages >= pageCap) return { points: collected, pages, truncated: true };
    }
  }

  /** Read the payload object for a type out of a data point. */
  static payload(type: DataType, point: DataPoint): Record<string, unknown> {
    const v = point[DATA_TYPES[type].payloadKey];
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  }

  /** Whether a civil date range is supported by this data type. */
  static filterable(type: DataType): boolean {
    return Boolean(DATA_TYPES[type].filterField.civil);
  }
}

/** Civil aggregation intentionally uses no fixed UTC offset or time-zone name. */
function dateAtMidnight(value: string | undefined): Record<string, unknown> {
  if (!value) throw new GoogleHealthError('Daily aggregation requires a start and exclusive end date');
  const [year, month, day] = value.split('-').map(Number);
  return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } };
}

/**
 * Turn a Google API error body into something actionable.
 *
 * `error.details[]` carries a BadRequest entry whose `fieldViolations[0]
 * .description` names the offending field — that message is how the whole filter
 * grammar in API-NOTES.md was reverse-engineered, so it is worth surfacing
 * rather than swallowing.
 */
function describeApiError(parsed: unknown, status: number): string {
  const err = (parsed as { error?: Record<string, unknown> })?.error;
  if (!err) return `Google Health API returned HTTP ${status}`;

  const details = Array.isArray(err.details) ? err.details : [];
  for (const d of details) {
    const violations = (d as { fieldViolations?: Array<{ description?: string }> })?.fieldViolations;
    if (Array.isArray(violations) && violations[0]?.description) {
      return `Google Health API rejected the request (HTTP ${status}): ${violations[0].description}`;
    }
  }
  const message = typeof err.message === 'string' ? err.message : `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return (
      `Google Health API denied access (HTTP ${status}): ${message}. ` +
      'Check that the Google Health API is enabled on the project and that the granted scopes ' +
      'cover this data type.'
    );
  }
  if (status === 429) {
    return `Google Health API rate limit hit (HTTP 429): ${message}. Retry in a few seconds.`;
  }
  return `Google Health API error (HTTP ${status}): ${message}`;
}
