import { describe, expect, it } from 'vitest';
import { clearHold, getHold, setHold } from './holds';

describe('start holds', () => {
  it('records why a task waits, keeps the first time when the reason changes, and forgets it', () => {
    expect(getHold('t1')).toBeNull();
    setHold('t1', 'its turn');
    const first = getHold('t1')!;
    expect(first.reason).toBe('its turn');
    setHold('t1', 'the machine is busy');
    expect(getHold('t1')).toEqual({ reason: 'the machine is busy', since: first.since });
    clearHold('t1');
    expect(getHold('t1')).toBeNull();
  });
});
