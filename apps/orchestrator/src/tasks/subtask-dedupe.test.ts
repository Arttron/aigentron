import { describe, expect, it } from 'vitest';
import { REUSABLE_STATUSES, isSameWork } from './subtask-dedupe';

describe('isSameWork', () => {
  it('identical or lightly reworded requests are the same work', () => {
    expect(isSameWork('Research the price of DS18B20 sensors at five suppliers.', 'research the price of DS18B20 sensors at five suppliers')).toBe(true);
    expect(isSameWork('Compare prices of the DS18B20 temperature sensor at five suppliers and make a table', 'Compare prices of the DS18B20 temperature sensor at five suppliers, make a table please')).toBe(true);
    expect(isSameWork('Сравни цены на датчик DS18B20 у пяти поставщиков и составь таблицу', 'сравни цены на датчик DS18B20 у пяти поставщиков и составь таблицу!')).toBe(true);
  });
  it('different work is not', () => {
    expect(isSameWork('Research the price of DS18B20 sensors at five suppliers', 'Write the firmware reading loop for the DS18B20 sensor over OneWire')).toBe(false);
    expect(isSameWork('Fix bug', 'Fix typo')).toBe(false); // too short to judge, and not equal
    expect(isSameWork('', 'x')).toBe(false);
  });
  it('a failed or cancelled subtask may be retried, a done / open one is reused', () => {
    expect(REUSABLE_STATUSES).toContain('done');
    expect(REUSABLE_STATUSES).toContain('running');
    expect(REUSABLE_STATUSES).not.toContain('failed');
    expect(REUSABLE_STATUSES).not.toContain('cancelled');
  });
});
