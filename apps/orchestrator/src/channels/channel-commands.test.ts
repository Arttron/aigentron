import { describe, expect, it } from 'vitest';
import { commandName } from './channel-commands.service';

describe('commandName', () => {
  it('strips the @botname suffix', () => {
    expect(commandName('/tasks@MyBot')).toBe('/tasks');
    expect(commandName('/Cancel@my_bot abc')).toBe('/cancel');
    expect(commandName('/tasks')).toBe('/tasks');
  });
});
