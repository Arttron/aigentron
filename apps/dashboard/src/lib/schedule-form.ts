/**
 * The schedule form speaks plain words (every day at 09:30, weekdays, every 4 hours); the server stores a 5-field cron.
 * `buildCron` / `parseCron` convert between the two so nobody has to write cron — and "custom" stays available.
 */
export type Preset = 'daily' | 'weekdays' | 'weekly' | 'hours' | 'custom';

export interface ScheduleFormState {
  preset: Preset;
  /** HH:MM */
  time: string;
  /** 0=Sunday … 6=Saturday (weekly) */
  days: number[];
  everyHours: number;
  custom: string;
}

export const DEFAULT_FORM: ScheduleFormState = { preset: 'daily', time: '09:00', days: [1], everyHours: 4, custom: '' };

const split = (time: string): [number, number] => {
  const [h, m] = time.split(':').map(Number);
  return [Number.isFinite(h) ? h! : 9, Number.isFinite(m) ? m! : 0];
};

export function buildCron(f: ScheduleFormState): string {
  const [h, m] = split(f.time);
  switch (f.preset) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${[...new Set(f.days)].sort((a, b) => a - b).join(',') || '1'}`;
    case 'hours':
      return `${m} */${Math.max(1, Math.round(f.everyHours))} * * *`;
    default:
      return f.custom.trim();
  }
}

export function parseCron(cron: string): ScheduleFormState {
  const c = cron.trim().replace(/\s+/g, ' ');
  const [mi, h, dom, mon, dow] = c.split(' ');
  const pad = (n: string) => n.padStart(2, '0');
  const custom: ScheduleFormState = { ...DEFAULT_FORM, preset: 'custom', custom: c };
  if (!mi || !/^\d+$/.test(mi) || mon !== '*' || dom !== '*') return custom;
  if (h && /^\d+$/.test(h)) {
    const time = `${pad(h)}:${pad(mi)}`;
    if (dow === '*') return { ...DEFAULT_FORM, preset: 'daily', time };
    if (dow === '1-5') return { ...DEFAULT_FORM, preset: 'weekdays', time };
    if (dow && /^[0-6](,[0-6])*$/.test(dow)) return { ...DEFAULT_FORM, preset: 'weekly', time, days: dow.split(',').map(Number) };
  }
  if (h?.startsWith('*/') && /^\d+$/.test(h.slice(2)) && dow === '*') return { ...DEFAULT_FORM, preset: 'hours', time: `00:${pad(mi)}`, everyHours: Number(h.slice(2)) };
  return custom;
}
