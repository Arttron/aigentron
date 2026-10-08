/** Schedule helpers that need no dependencies — shared by the orchestrator and the dashboard. */

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const isHM = (s: string): boolean => HM.test(s);

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: string | number) => String(n).padStart(2, '0');

/** A short human description of common patterns; the raw cron otherwise. */
export function describeSchedule(cron: string, tz: string): string {
  const c = cron.trim().replace(/\s+/g, ' ');
  const [mi, h, dom, mon, dow] = c.split(' ');
  const where = tz === 'UTC' ? 'UTC' : tz;
  if (mi && /^\d+$/.test(mi) && h && /^\d+$/.test(h) && mon === '*') {
    const at = `${pad(h)}:${pad(mi)}`;
    if (dom === '*' && dow === '*') return `every day at ${at} (${where})`;
    if (dom === '*' && dow === '1-5') return `weekdays at ${at} (${where})`;
    if (dom === '*' && dow === '0,6') return `weekends at ${at} (${where})`;
    if (dom === '*' && /^\d$/.test(dow ?? '')) return `every ${DAYS[Number(dow) % 7]} at ${at} (${where})`;
    if (dom === '*' && /^[0-7](,[0-7])+$/.test(dow ?? '')) return `${(dow ?? '').split(',').map((d) => DAYS[Number(d) % 7]!.slice(0, 3)).join(', ')} at ${at} (${where})`;
    if (/^\d+$/.test(dom ?? '') && dow === '*') return `on day ${dom} of every month at ${at} (${where})`;
  }
  if (h === '*' && dom === '*' && mon === '*' && dow === '*' && mi?.startsWith('*/')) return `every ${mi.slice(2)} minutes`;
  if (mi && /^\d+$/.test(mi) && h?.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return `every ${h.slice(2)} hours (at minute ${pad(mi)}, ${where})`;
  return `cron "${c}" (${where})`;
}
