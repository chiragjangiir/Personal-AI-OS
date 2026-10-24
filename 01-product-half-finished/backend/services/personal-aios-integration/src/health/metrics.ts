/** The one catalog of owner health metrics: the tool's key, the phone's wire key (its HealthMetric raw value), the unit
 *  the phone converts to (HealthTypes canonicalUnit), how a day aggregates, how 依米 says it. */
export type HealthKind = 'cumulative' | 'discrete' | 'sleep' | 'workout' | 'event';
export interface HealthMetricSpec {
  key: string; wire: string; label: string; unit: string; display: string; kind: HealthKind;
}
export const HEALTH_METRICS: readonly HealthMetricSpec[] = Object.freeze(([
  {key: 'sleep', wire: 'sleepAnalysis', label: '睡眠', unit: 'category-code', display: '', kind: 'sleep'},
  {key: 'heart_rate', wire: 'heartRate', label: '心率', unit: 'count/min', display: '次/分', kind: 'discrete'},
  {key: 'resting_heart_rate', wire: 'restingHeartRate', label: '静息心率', unit: 'count/min', display: '次/分', kind: 'discrete'},
  {key: 'hrv', wire: 'heartRateVariabilitySDNN', label: '心率变异性(SDNN)', unit: 'ms', display: '毫秒', kind: 'discrete'},
  {key: 'respiratory_rate', wire: 'respiratoryRate', label: '呼吸频率', unit: 'count/min', display: '次/分', kind: 'discrete'},
  {key: 'blood_oxygen', wire: 'oxygenSaturation', label: '血氧', unit: '%', display: '%', kind: 'discrete'},
  {key: 'steps', wire: 'stepCount', label: '步数', unit: 'count', display: '步', kind: 'cumulative'},
  {key: 'active_energy', wire: 'activeEnergyBurned', label: '活动能量', unit: 'kcal', display: '千卡', kind: 'cumulative'},
  {key: 'exercise_time', wire: 'appleExerciseTime', label: '锻炼时间', unit: 'min', display: '分钟', kind: 'cumulative'},
  {key: 'workouts', wire: 'workout', label: '体能训练', unit: 'workout', display: '', kind: 'workout'},
  {key: 'walking_steadiness', wire: 'appleWalkingSteadiness', label: '步行稳定性', unit: '%', display: '%', kind: 'discrete'},
  {key: 'high_heart_rate_event', wire: 'highHeartRateEvent', label: '高心率事件', unit: 'category-code', display: '', kind: 'event'},
  {key: 'low_heart_rate_event', wire: 'lowHeartRateEvent', label: '低心率事件', unit: 'category-code', display: '', kind: 'event'},
  {key: 'irregular_heart_rhythm_event', wire: 'irregularHeartRhythmEvent', label: '心律不齐事件', unit: 'category-code', display: '', kind: 'event'},
  {key: 'falls', wire: 'numberOfTimesFallen', label: '摔倒次数', unit: 'count', display: '次', kind: 'cumulative'},
  {key: 'body_temperature', wire: 'bodyTemperature', label: '体温', unit: 'degC', display: '°C', kind: 'discrete'},
  {key: 'wrist_temperature', wire: 'appleSleepingWristTemperature', label: '睡眠腕温', unit: 'degC', display: '°C', kind: 'discrete'},
] satisfies HealthMetricSpec[]).map(spec => Object.freeze(spec)));
export const metricByKey = (key: string) => HEALTH_METRICS.find(spec => spec.key === key);
export const metricByWire = (wire: string) => HEALTH_METRICS.find(spec => spec.wire === wire);

/** HKCategoryValueSleepAnalysis codes. */
export const SLEEP = {inBed: 0, asleep: 1, awake: 2, core: 3, deep: 4, rem: 5} as const;
export const SLEEP_NAMES = ['在床', '睡着', '清醒', '核心睡眠', '深睡', 'REM'] as const;
/** Common HKWorkoutActivityType raw values; anything else is 训练. */
const WORKOUT_NAMES: Record<number, string> = {13: '骑行', 16: '椭圆机', 20: '功能性力量训练', 24: '徒步', 35: '划船', 37: '跑步',
  44: '爬楼', 46: '游泳', 50: '力量训练', 52: '步行', 57: '瑜伽', 59: '核心训练', 63: '高强度间歇训练', 64: '跳绳', 66: '普拉提', 72: '太极', 73: '混合有氧'};
export const workoutName = (type: number) => WORKOUT_NAMES[type] ?? '训练';
