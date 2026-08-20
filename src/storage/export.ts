/**
 * JSON/CSV export and JSON import for session data. Import validates
 * structurally before accepting anything — malformed input is rejected with
 * a descriptive error rather than partially written into the store.
 */
import type { AccelCurve, AimSample, SensConfig, SessionRecord, SessionSummary, ShotEvent } from '../core/types';

const EXPORT_VERSION = 1;

export interface ExportEnvelope {
  version: number;
  exportedAt: number;
  sessions: SessionRecord[];
}

export function exportJSON(sessions: SessionRecord[]): string {
  const envelope: ExportEnvelope = { version: EXPORT_VERSION, exportedAt: Date.now(), sessions };
  return JSON.stringify(envelope, null, 2);
}

// ------------------------------------------------------------------- CSV ---

/** Column order for `exportCSV` — every `ShotEvent` field, prefixed with session context. */
const CSV_COLUMNS = [
  'sessionId',
  'startedAt',
  'scenarioId',
  'sessionWeaponId',
  'sensitivity',
  'rawAccelEnabled',
  'dpi',
  'eDPI',
  'cm360',
  't',
  'weaponId',
  'shotIndexInBurst',
  'hit',
  'zone',
  'targetId',
  'distanceM',
  'errorAngleDeg',
  'errorYawDeg',
  'errorPitchDeg',
  'timeToTargetMs',
  'overshootDeg',
  'microCorrections',
  'pathLengthDeg',
  'directAngleDeg',
  'peakAngularVelDeg',
  'spreadDeg',
  'recoilYawDeg',
  'recoilPitchDeg',
  'playerSpeed',
  'effectiveGain',
] as const;

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per shot, flat, with every `ShotEvent` field plus enough session context to analyse it standalone. */
export function exportCSV(sessions: SessionRecord[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];

  for (const session of sessions) {
    for (const shot of session.shots) {
      const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
        sessionId: session.id,
        startedAt: session.startedAt,
        scenarioId: session.scenarioId,
        sessionWeaponId: session.weaponId,
        sensitivity: session.sens.sensitivity,
        rawAccelEnabled: session.rawAccelEnabled,
        dpi: session.sens.dpi,
        eDPI: session.eDPI,
        cm360: session.cm360,
        t: shot.t,
        weaponId: shot.weaponId,
        shotIndexInBurst: shot.shotIndexInBurst,
        hit: shot.hit,
        zone: shot.zone ?? '',
        targetId: shot.targetId ?? '',
        distanceM: shot.distanceM,
        errorAngleDeg: shot.errorAngleDeg,
        errorYawDeg: shot.errorYawDeg,
        errorPitchDeg: shot.errorPitchDeg,
        timeToTargetMs: shot.timeToTargetMs ?? '',
        overshootDeg: shot.overshootDeg,
        microCorrections: shot.microCorrections,
        pathLengthDeg: shot.pathLengthDeg,
        directAngleDeg: shot.directAngleDeg,
        peakAngularVelDeg: shot.peakAngularVelDeg,
        spreadDeg: shot.spreadDeg,
        recoilYawDeg: shot.recoilYawDeg,
        recoilPitchDeg: shot.recoilPitchDeg,
        playerSpeed: shot.playerSpeed,
        effectiveGain: shot.effectiveGain,
      };
      rows.push(CSV_COLUMNS.map((c) => csvEscape(row[c])).join(','));
    }
  }

  return rows.join('\n');
}

// -------------------------------------------------------------- import ----

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(`Invalid session export: ${message}`);
    this.name = 'ImportValidationError';
  }
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function isString(x: unknown): x is string {
  return typeof x === 'string';
}
function isBoolean(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new ImportValidationError(msg);
}

function validateAccelCurve(v: unknown, path: string): asserts v is AccelCurve {
  assert(isObject(v), `${path} must be an object`);
  assert(isString(v.type), `${path}.type must be a string`);
  const numericFields = [
    'sensMultiplier',
    'acceleration',
    'exponent',
    'inputOffset',
    'outputCap',
    'inputCap',
    'decayRate',
    'limit',
    'syncSpeed',
    'gamma',
    'smooth',
    'motivity',
    'growthRate',
    'midpoint',
  ];
  for (const f of numericFields) assert(isNumber(v[f]), `${path}.${f} must be a number`);
  assert(isBoolean(v.applyToY), `${path}.applyToY must be a boolean`);
}

function validateSensConfig(v: unknown, path: string): asserts v is SensConfig {
  assert(isObject(v), `${path} must be an object`);
  assert(isNumber(v.dpi), `${path}.dpi must be a number`);
  assert(isNumber(v.pollingRateHz), `${path}.pollingRateHz must be a number`);
  assert(isNumber(v.sensitivity), `${path}.sensitivity must be a number`);
  assert(isNumber(v.scopedMultiplier), `${path}.scopedMultiplier must be a number`);
  assert(isBoolean(v.rawAccelEnabled), `${path}.rawAccelEnabled must be a boolean`);
  assert(isBoolean(v.invertY), `${path}.invertY must be a boolean`);
  validateAccelCurve(v.curve, `${path}.curve`);
}

function validateShotEvent(v: unknown, path: string): asserts v is ShotEvent {
  assert(isObject(v), `${path} must be an object`);
  assert(isNumber(v.t), `${path}.t must be a number`);
  assert(isString(v.weaponId), `${path}.weaponId must be a string`);
  assert(isNumber(v.shotIndexInBurst), `${path}.shotIndexInBurst must be a number`);
  assert(isBoolean(v.hit), `${path}.hit must be a boolean`);
  assert(v.zone === null || isString(v.zone), `${path}.zone must be a string or null`);
  assert(v.targetId === null || isString(v.targetId), `${path}.targetId must be a string or null`);
  assert(isNumber(v.distanceM), `${path}.distanceM must be a number`);
  assert(isNumber(v.errorAngleDeg), `${path}.errorAngleDeg must be a number`);
  assert(isNumber(v.errorYawDeg), `${path}.errorYawDeg must be a number`);
  assert(isNumber(v.errorPitchDeg), `${path}.errorPitchDeg must be a number`);
  assert(v.timeToTargetMs === null || isNumber(v.timeToTargetMs), `${path}.timeToTargetMs must be a number or null`);
  assert(isNumber(v.overshootDeg), `${path}.overshootDeg must be a number`);
  assert(isNumber(v.microCorrections), `${path}.microCorrections must be a number`);
  assert(isNumber(v.pathLengthDeg), `${path}.pathLengthDeg must be a number`);
  assert(isNumber(v.directAngleDeg), `${path}.directAngleDeg must be a number`);
  assert(isNumber(v.peakAngularVelDeg), `${path}.peakAngularVelDeg must be a number`);
  assert(isNumber(v.spreadDeg), `${path}.spreadDeg must be a number`);
  assert(isNumber(v.recoilYawDeg), `${path}.recoilYawDeg must be a number`);
  assert(isNumber(v.recoilPitchDeg), `${path}.recoilPitchDeg must be a number`);
  assert(isNumber(v.playerSpeed), `${path}.playerSpeed must be a number`);
  assert(isNumber(v.effectiveGain), `${path}.effectiveGain must be a number`);
}

function validateAimSample(v: unknown, path: string): asserts v is AimSample {
  assert(isObject(v), `${path} must be an object`);
  assert(isNumber(v.t), `${path}.t must be a number`);
  assert(isNumber(v.yaw), `${path}.yaw must be a number`);
  assert(isNumber(v.pitch), `${path}.pitch must be a number`);
  assert(isNumber(v.dx), `${path}.dx must be a number`);
  assert(isNumber(v.dy), `${path}.dy must be a number`);
  assert(isNumber(v.gain), `${path}.gain must be a number`);
}

function validateSummary(v: unknown, path: string): asserts v is SessionSummary {
  assert(isObject(v), `${path} must be an object`);
  const fields: (keyof SessionSummary)[] = [
    'shots',
    'hits',
    'accuracy',
    'headshots',
    'headshotRate',
    'kills',
    'score',
    'avgTimeToTargetMs',
    'avgErrorDeg',
    'overshootBias',
    'avgMicroCorrections',
    'pathEfficiency',
    'trackingAccuracy',
    'errorConsistency',
  ];
  for (const f of fields) assert(isNumber(v[f]), `${path}.${f} must be a number`);
}

function validateSession(v: unknown, path: string): asserts v is SessionRecord {
  assert(isObject(v), `${path} must be an object`);
  assert(isString(v.id), `${path}.id must be a string`);
  assert(isNumber(v.startedAt), `${path}.startedAt must be a number`);
  assert(isNumber(v.endedAt), `${path}.endedAt must be a number`);
  assert(isString(v.scenarioId), `${path}.scenarioId must be a string`);
  assert(isString(v.weaponId), `${path}.weaponId must be a string`);
  validateSensConfig(v.sens, `${path}.sens`);
  assert(isNumber(v.eDPI), `${path}.eDPI must be a number`);
  assert(isNumber(v.cm360), `${path}.cm360 must be a number`);
  assert(isBoolean(v.rawAccelEnabled), `${path}.rawAccelEnabled must be a boolean`);
  validateSummary(v.summary, `${path}.summary`);
  assert(Array.isArray(v.shots), `${path}.shots must be an array`);
  v.shots.forEach((s, i) => validateShotEvent(s, `${path}.shots[${i}]`));
  assert(Array.isArray(v.samples), `${path}.samples must be an array`);
  v.samples.forEach((s, i) => validateAimSample(s, `${path}.samples[${i}]`));
}

/**
 * Parses and validates a JSON export. Throws `ImportValidationError` on any
 * structural problem — the whole import is rejected (not partially applied)
 * so a malformed file can never corrupt the store with half-valid sessions.
 */
export function importJSON(text: string): SessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ImportValidationError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }

  assert(isObject(parsed), 'root must be an object');
  assert(isNumber(parsed.version), 'missing/invalid "version"');
  assert(Array.isArray(parsed.sessions), 'missing/invalid "sessions" array');

  parsed.sessions.forEach((s, i) => validateSession(s, `sessions[${i}]`));
  return parsed.sessions as SessionRecord[];
}
