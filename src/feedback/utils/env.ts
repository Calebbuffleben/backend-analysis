/**
 * Parse an environment variable as boolean.
 * Single source of truth (see solution-understood-third-party-libs.spec.md).
 */
export function parseEnvBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return defaultValue;
  const v = raw.replace(/"/g, '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'n' || v === 'off') return false;
  return defaultValue;
}

/**
 * Parse an environment variable as number. Returns defaultVal if missing or invalid.
 * Value is clamped to >= 0.
 */
export function readEnvNumber(key: string, defaultVal: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return defaultVal;
  const parsed = Number.parseFloat(String(raw).replace(/"/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : defaultVal;
}
