import { describe, expect, it } from 'vitest';
import { describeNow } from './clock';

describe('describeNow', () => {
  const at = new Date('2026-10-11T14:23:05Z');
  it('tells the date and time in a given zone', () => {
    const s = describeNow(at, 'Europe/Kyiv');
    expect(s).toContain('Sunday, 11 October 2026, 17:23:05');
    expect(s).toContain('Europe/Kyiv');
    expect(s).toContain('UTC+03:00');
    expect(s).toContain('UTC: 2026-10-11T14:23:05Z');
    expect(s).not.toContain("server's timezone");
  });
  it('handles another zone and the date line', () => {
    expect(describeNow(at, 'America/New_York')).toContain('10:23:05');
    expect(describeNow(new Date('2026-10-11T23:30:00Z'), 'Asia/Tokyo')).toContain('Monday, 12 October 2026, 08:30:00');
  });
  it('defaults to the server zone and says so; a bad zone is an error text', () => {
    expect(describeNow(at)).toContain("server's timezone");
    expect(describeNow(at, 'Mars/Base')).toContain('Unknown timezone');
  });
});
