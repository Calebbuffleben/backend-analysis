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
