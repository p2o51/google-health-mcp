/**
 * Read capabilities from the Google Health API data-type and REST references.
 * Checked 2026-10-20. Keep endpoint names (kebab case), payload keys (camel case)
 * and filter fields (protobuf snake case) distinct.
 *
 * Sources:
 * https://developers.google.com/health/data-types
 * https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/list
 * https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/dailyRollUp
 */
export type RecordType = 'interval' | 'sample' | 'daily' | 'session';
export type SourceFamily = 'all-sources' | 'google-wearables' | 'google-sources' | 'self-sources';
export const SOURCE_FAMILIES: readonly SourceFamily[] = [
  'all-sources', 'google-wearables', 'google-sources', 'self-sources',
];

export interface DataTypeDefinition {
  payloadKey: string;
  recordType: RecordType;
  scope: string;
  version: 'v4' | 'v4beta';
  list: boolean;
  reconcile: boolean;
  rollup: boolean;
  dailyRollup: boolean;
  filterField: { civil: string | null; physical: string | null };
  maxAggregateDays: 14 | 90;
  maxPageSize: number;
}

const ACTIVITY = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
const METRICS = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';
const SLEEP = 'https://www.googleapis.com/auth/googlehealth.sleep.readonly';

function definition(
  id: string,
  payloadKey: string,
  recordType: RecordType,
  scope: string,
  options: Partial<Pick<DataTypeDefinition,
    'list' | 'reconcile' | 'rollup' | 'dailyRollup' | 'version' | 'maxAggregateDays'>> = {},
): DataTypeDefinition {
  const prefix = id.replaceAll('-', '_');
  const intervalEnd = id === 'sleep';
  const civil = recordType === 'daily'
    ? `${prefix}.date`
    : recordType === 'sample'
      ? `${prefix}.sample_time.civil_time`
      : `${prefix}.interval.civil_${intervalEnd ? 'end' : 'start'}_time`;
  // Exercise explicitly supports civil_start_time only (live HTTP 400 for
  // interval.start_time); daily records also have no physical-time filter.
  const physical = recordType === 'daily' || id === 'exercise'
    ? null
    : recordType === 'sample'
      ? `${prefix}.sample_time.physical_time`
      : `${prefix}.interval.${intervalEnd ? 'end' : 'start'}_time`;
  const rollup = options.rollup ?? false;
  return {
    payloadKey,
    recordType,
    scope,
    version: options.version ?? 'v4',
    list: options.list ?? true,
    reconcile: options.reconcile ?? true,
    rollup,
    dailyRollup: options.dailyRollup ?? rollup,
    filterField: { civil, physical },
    maxAggregateDays: options.maxAggregateDays ?? 90,
    maxPageSize: id === 'sleep' || id === 'exercise' ? 25 : 10_000,
  };
}

/** Optional nutrition/ECG/IRN entries require additional Google consent. */
const NUTRITION = 'https://www.googleapis.com/auth/googlehealth.nutrition.readonly';
export const DATA_TYPES = {
  'hydration-log': definition('hydration-log', 'hydrationLog', 'session', NUTRITION, { rollup: true }),
  'nutrition-log': definition('nutrition-log', 'nutritionLog', 'session', NUTRITION, { rollup: true }),
  electrocardiogram: { ...definition('electrocardiogram', 'electrocardiogram', 'session', 'https://www.googleapis.com/auth/googlehealth.ecg.readonly', { reconcile: false }), maxPageSize: 25, filterField: { civil: null, physical: 'electrocardiogram.interval.start_time' } },
  'irregular-rhythm-notification': { ...definition('irregular-rhythm-notification', 'irregularRhythmNotification', 'session', 'https://www.googleapis.com/auth/googlehealth.irn.readonly', { reconcile: false }), maxPageSize: 25, filterField: { civil: null, physical: null } },
  steps: definition('steps', 'steps', 'interval', ACTIVITY, { rollup: true }),
  sleep: definition('sleep', 'sleep', 'session', SLEEP),
  exercise: definition('exercise', 'exercise', 'session', ACTIVITY),
  weight: definition('weight', 'weight', 'sample', METRICS, { rollup: true }),
  'daily-resting-heart-rate': definition('daily-resting-heart-rate', 'dailyRestingHeartRate', 'daily', METRICS),
  'active-energy-burned': definition('active-energy-burned', 'activeEnergyBurned', 'interval', ACTIVITY, { rollup: true }),
  'active-zone-minutes': definition('active-zone-minutes', 'activeZoneMinutes', 'interval', ACTIVITY, { rollup: true }),
  'active-minutes': definition('active-minutes', 'activeMinutes', 'interval', ACTIVITY, { rollup: true, maxAggregateDays: 14 }),
  'activity-level': definition('activity-level', 'activityLevel', 'interval', ACTIVITY),
  altitude: definition('altitude', 'altitude', 'interval', ACTIVITY, { rollup: true }),
  distance: definition('distance', 'distance', 'interval', ACTIVITY, { rollup: true }),
  floors: definition('floors', 'floors', 'interval', ACTIVITY, { list: false, rollup: true }),
  'total-calories': definition('total-calories', 'totalCalories', 'interval', ACTIVITY, { list: false, reconcile: false, rollup: true, maxAggregateDays: 14 }),
  'calories-in-heart-rate-zone': definition('calories-in-heart-rate-zone', 'caloriesInHeartRateZone', 'interval', ACTIVITY, { list: false, reconcile: false, rollup: true, maxAggregateDays: 14 }),
  'time-in-heart-rate-zone': definition('time-in-heart-rate-zone', 'timeInHeartRateZone', 'interval', ACTIVITY, { rollup: true }),
  'sedentary-period': definition('sedentary-period', 'sedentaryPeriod', 'interval', ACTIVITY, { rollup: true }),
  'swim-lengths-data': definition('swim-lengths-data', 'swimLengthsData', 'interval', ACTIVITY, { rollup: true }),
  'daily-vo2-max': definition('daily-vo2-max', 'dailyVo2Max', 'daily', ACTIVITY),
  'run-vo2-max': definition('run-vo2-max', 'runVo2Max', 'sample', ACTIVITY, { rollup: true }),
  'vo2-max': definition('vo2-max', 'vo2Max', 'sample', ACTIVITY),
  'heart-rate': definition('heart-rate', 'heartRate', 'sample', METRICS, { rollup: true, maxAggregateDays: 14 }),
  'heart-rate-variability': definition('heart-rate-variability', 'heartRateVariability', 'sample', METRICS),
  'daily-heart-rate-variability': definition('daily-heart-rate-variability', 'dailyHeartRateVariability', 'daily', METRICS),
  'daily-heart-rate-zones': definition('daily-heart-rate-zones', 'dailyHeartRateZones', 'daily', METRICS),
  'oxygen-saturation': definition('oxygen-saturation', 'oxygenSaturation', 'sample', METRICS),
  'daily-oxygen-saturation': definition('daily-oxygen-saturation', 'dailyOxygenSaturation', 'daily', METRICS),
  'daily-respiratory-rate': definition('daily-respiratory-rate', 'dailyRespiratoryRate', 'daily', METRICS),
  'respiratory-rate-sleep-summary': definition('respiratory-rate-sleep-summary', 'respiratoryRateSleepSummary', 'sample', METRICS),
  'daily-sleep-temperature-derivations': definition('daily-sleep-temperature-derivations', 'dailySleepTemperatureDerivations', 'daily', METRICS),
  'body-fat': definition('body-fat', 'bodyFat', 'sample', METRICS, { rollup: true }),
  height: definition('height', 'height', 'sample', METRICS),
  'core-body-temperature': definition('core-body-temperature', 'coreBodyTemperature', 'sample', METRICS, { rollup: true }),
  'blood-glucose': definition('blood-glucose', 'bloodGlucose', 'sample', METRICS, { rollup: true }),
  'skin-temperature-sensors': definition('skin-temperature-sensors', 'skinTemperatureSensors', 'sample', METRICS, { version: 'v4beta', reconcile: false }),
} as const satisfies Record<string, DataTypeDefinition>;

export type DataType = keyof typeof DATA_TYPES;
