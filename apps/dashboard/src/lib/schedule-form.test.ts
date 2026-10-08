import { describe, expect, it } from 'vitest';
import { DEFAULT_FORM, buildCron, parseCron } from './schedule-form';

describe('buildCron', () => {
  it('builds the presets', () => {
    expect(buildCron({ ...DEFAULT_FORM, preset: 'daily', time: '09:30' })).toBe('30 9 * * *');
    expect(buildCron({ ...DEFAULT_FORM, preset: 'weekdays', time: '08:00' })).toBe('0 8 * * 1-5');
    expect(buildCron({ ...DEFAULT_FORM, preset: 'weekly', time: '18:15', days: [5, 1, 3, 1] })).toBe('15 18 * * 1,3,5');
    expect(buildCron({ ...DEFAULT_FORM, preset: 'hours', time: '00:10', everyHours: 4 })).toBe('10 */4 * * *');
    expect(buildCron({ ...DEFAULT_FORM, preset: 'custom', custom: ' 0 0 1 * * ' })).toBe('0 0 1 * *');
  });
  it('weekly with no day falls back to Monday rather than an invalid cron', () => {
    expect(buildCron({ ...DEFAULT_FORM, preset: 'weekly', days: [] })).toBe('0 9 * * 1');
  });
});

describe('parseCron round-trips what it builds', () => {
  it.each(['30 9 * * *', '0 8 * * 1-5', '15 18 * * 1,3,5', '10 */4 * * *'])('%s', (cron) => {
    expect(buildCron(parseCron(cron))).toBe(cron);
  });
  it('anything else stays custom', () => {
    expect(parseCron('0 9 1 * *')).toMatchObject({ preset: 'custom', custom: '0 9 1 * *' });
    expect(parseCron('*/15 * * * *').preset).toBe('custom');
  });
});
