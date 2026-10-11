/** "What time is it?" for agents (they have no clock). Pure, unit-tested. */

/** The server's own zone: env TZ, else what the runtime resolved, else UTC. */
export function serverTimeZone(): string {
  return process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** A sentence-level answer: weekday, date, time, zone with offset, plus UTC and unix time. Unknown zone → an error text (never throws). */
export function describeNow(now: Date, timezone?: string): string {
  const tz = timezone || serverTimeZone();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset' }).formatToParts(now);
  } catch {
    return `Unknown timezone "${tz}". Use an IANA name such as "Europe/Kyiv" or "America/New_York" (UTC now: ${now.toISOString()}).`;
  }
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const offset = get('timeZoneName').replace('GMT', 'UTC') || 'UTC';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `Now: ${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}, ${hour}:${get('minute')}:${get('second')} (${tz}, ${offset === 'UTC' ? 'UTC+00:00' : offset}). UTC: ${now.toISOString().replace(/\.\d+Z$/, 'Z')}. Unix: ${Math.floor(now.getTime() / 1000)}.${timezone ? '' : ' (This is the server\'s timezone — the user may be elsewhere.)'}`;
}
