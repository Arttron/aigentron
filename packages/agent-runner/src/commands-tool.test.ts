import { describe, expect, it } from 'vitest';
import { COMMANDS_TOOL, withCommandsTool } from './env';

describe('withCommandsTool', () => {
  it('adds the pipeline tool to an exclusive whitelist when the run has the server, once', () => {
    expect(withCommandsTool(['Read', 'Bash'], true)).toEqual(['Read', 'Bash', COMMANDS_TOOL]);
    expect(withCommandsTool(['Read', 'Bash', COMMANDS_TOOL], true)).toEqual(['Read', 'Bash', COMMANDS_TOOL]);
  });
  it('leaves a whitelist alone without the server, and "no whitelist" stays no whitelist', () => {
    expect(withCommandsTool(['Read', 'Bash'], false)).toEqual(['Read', 'Bash']);
    expect(withCommandsTool(undefined, true)).toBeUndefined();
    expect(withCommandsTool([], true)).toEqual([]); // empty = no whitelist
  });
});
