import type { GoogleHealthClient } from './google.ts';
import { ToolError, type ToolDefinition } from './mcp.ts';
import type { Env } from './tools.ts';
import { realDate } from './queries.ts';
import { WRITE_SCHEMAS, MEAL_TYPES, NUTRIENTS } from './write-schemas.ts';

function timestamp(v: unknown): void {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v))) throw new ToolError('Write times must be valid RFC3339 timestamps with a timezone.');
  realDate(v.slice(0, 10), 'timestamp');
  if (Number(v.slice(11,13)) > 23 || Number(v.slice(14,16)) > 59 || Number(v.slice(17,19)) > 59) throw new ToolError('Invalid time.');
}
export function validateRecord(type: string, raw: unknown): Record<string, any> {
  if (typeof raw !== 'string' || raw.length > 16_384) throw new ToolError('record_json must be JSON up to 16 KiB.');
  let data: Record<string, any>;
  try { data = JSON.parse(raw); } catch { throw new ToolError('Invalid record_json'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ToolError('record_json must contain one payload object.');
  const schema = WRITE_SCHEMAS[type];
  if (!schema) throw new ToolError('Unsupported writable data type');
  for (const key of Object.keys(data)) if (!schema.fields.includes(key)) throw new ToolError(`Unsupported field: ${key}`);
  if (type === 'moods' || type === 'symptoms') {
    if (!data.sampleTime || typeof data.sampleTime !== 'object') throw new ToolError('sampleTime.physicalTime is required');
    timestamp(data.sampleTime.physicalTime);
    for (const key of Object.keys(data.sampleTime)) if (!['physicalTime', 'utcOffset'].includes(key)) throw new ToolError('Unsupported sampleTime field');
    for (const [field, allowed] of Object.entries(schema.enums)) {
      const values = data[field];
      if (field === 'valences' && values == null) continue;
      if (!Array.isArray(values) || !values.length || values.length > 20 || values.some(v => !allowed.includes(v))) throw new ToolError(`Invalid ${field}; use documented Google enum values.`);
    }
  } else {
    if (!data.interval || typeof data.interval !== 'object') throw new ToolError('interval is required');
    for (const key of Object.keys(data.interval)) if (!['startTime', 'endTime', 'startUtcOffset', 'endUtcOffset'].includes(key)) throw new ToolError('Unsupported interval field');
    timestamp(data.interval.startTime); timestamp(data.interval.endTime);
    if (Date.parse(data.interval.endTime) < Date.parse(data.interval.startTime)) throw new ToolError('endTime must not precede startTime.');
  }
  const positive = (n: unknown, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  if (type === 'hydration-log' && (!positive(data.amountConsumed?.milliliters, 100000) || Object.keys(data.amountConsumed).some(k => !['milliliters', 'userProvidedUnit'].includes(k)))) throw new ToolError('amountConsumed.milliliters must be a number from 0 to 100000.');
  if (type === 'nutrition-log') {
    if (typeof data.foodDisplayName !== 'string' || !data.foodDisplayName.trim() || data.foodDisplayName.length > 200) throw new ToolError('foodDisplayName is required (up to 200 characters).');
    if (data.energy != null && (!positive(data.energy?.kcal, 100000) || Object.keys(data.energy).some(k => k !== 'kcal'))) throw new ToolError('energy.kcal must be 0–100000.');
    if (data.mealType != null && !MEAL_TYPES.includes(data.mealType)) throw new ToolError('Invalid mealType.');
    if (data.food != null) throw new ToolError('Use anonymous foodDisplayName records; identified food references are not supported by this tool.');
    for (const field of ['totalCarbohydrate', 'totalFat']) if (data[field] != null && !positive(data[field]?.grams, 100000)) throw new ToolError(`${field}.grams must be nonnegative.`);
    if (data.energyFromFat != null && !positive(data.energyFromFat?.kcal, 100000)) throw new ToolError('Invalid energyFromFat.kcal');
    if (data.serving != null && !positive(data.serving?.amount, 100000)) throw new ToolError('Invalid serving.amount');
    if (data.nutrients != null && (!Array.isArray(data.nutrients) || data.nutrients.length > 100 || data.nutrients.some((n: any) => !n || !NUTRIENTS.includes(n.nutrient) || !positive(n.quantity?.grams, 100000)))) throw new ToolError('Each nutrient requires a nutrient enum and nonnegative quantity.grams.');
  }
  if (data.notes != null && (typeof data.notes !== 'string' || data.notes.length > 2000)) throw new ToolError('notes must be text up to 2000 characters');
  const offset = (time: string, current: unknown) => {
    if (current != null) {
      if (typeof current !== 'string' || !/^-?\d+s$/.test(current) || Math.abs(Number(current.slice(0,-1))) > 64800) throw new ToolError('UTC offsets must be integer seconds, for example 32400s.');
      return current;
    }
    const match = time.match(/([+-])(\d\d):(\d\d)$/);
    return `${match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60) : 0}s`;
  };
  if (data.sampleTime) data.sampleTime.utcOffset = offset(data.sampleTime.physicalTime, data.sampleTime.utcOffset);
  if (data.interval) {
    data.interval.startUtcOffset = offset(data.interval.startTime, data.interval.startUtcOffset);
    data.interval.endUtcOffset = offset(data.interval.endTime, data.interval.endUtcOffset);
  }
  return data;
}
export function buildWriteTools(clientFor: (env: Env) => GoogleHealthClient): ToolDefinition<Env>[] {
  return [{
    name: 'log_health_record',
    description: 'Preview or create a hydration, nutrition, mood, symptom or menstrual-period record. Disabled unless ENABLE_WRITES=1; requires MCP health:write and the matching Google writeonly scope. First use confirm=false and show the exact payload to the user; only set confirm=true after explicit user confirmation. Never retry a timed-out write automatically: it may already have succeeded. Nutrition supports anonymous food records only; these cannot be edited upstream.',
    inputSchema: { type: 'object', properties: {
      data_type: { type: 'string', enum: Object.keys(WRITE_SCHEMAS), description: 'Supported log type. Payload fields are documented in docs/TOOLS.md.' },
      record_json: { type: 'string', description: 'The JSON payload only, without a DataPoint wrapper, name, owner or dataSource.' },
      confirm: { type: 'boolean', description: 'false for local validation/preview; true only after the user approves this exact write.' },
    }, required: ['data_type','record_json','confirm'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    securitySchemes: [{ type: 'oauth2', scopes: ['health:write'] }],
    async handler(args, ctx) {
      if (ctx.env.ENABLE_WRITES !== '1') throw new ToolError('Writes are disabled by the deployment.');
      if (typeof args.data_type !== 'string' || typeof args.confirm !== 'boolean') throw new ToolError('data_type and boolean confirm are required.');
      const payload = validateRecord(args.data_type, args.record_json);
      if (!args.confirm) return { text: JSON.stringify({ preview: true, data_type: args.data_type, payload }), structured: { preview: true, data_type: args.data_type, payload } };
      const result = await clientFor(ctx.env).createRecord(args.data_type, payload);
      if (result.error) throw new ToolError('Google rejected the write operation.', { error: result.error });
      return { text: JSON.stringify(result), structured: { operation: result, completed: result.done === true, note: result.done === true ? 'Google reports completion.' : 'Accepted but not confirmed complete; do not resubmit.' } };
    },
  }];
}
