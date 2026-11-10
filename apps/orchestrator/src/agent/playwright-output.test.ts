import { describe, expect, it } from 'vitest';
import { playwrightOutputCandidate } from './playwright-output';

const DIR = '/var/lib/aigentron-playwright/output';

describe('playwrightOutputCandidate', () => {
  it('a bare or relative name of a picture is a file of the browser\'s output folder', () => {
    expect(playwrightOutputCandidate('whoami-proxy-lt.png', DIR)).toBe(`${DIR}/whoami-proxy-lt.png`);
    expect(playwrightOutputCandidate('output/whoami.png', DIR)).toBe(`${DIR}/whoami.png`);
    expect(playwrightOutputCandidate('.playwright-mcp/page-2026.jpeg', DIR)).toBe(`${DIR}/page-2026.jpeg`);
  });
  it('nothing for an absolute path, a path out of the folder, or a file that is not a picture', () => {
    expect(playwrightOutputCandidate('/etc/passwd.png', DIR)).toBeNull();
    expect(playwrightOutputCandidate('../secrets/x.png', DIR)).toBeNull();
    expect(playwrightOutputCandidate('a/../b.png', DIR)).toBeNull();
    expect(playwrightOutputCandidate('notes.txt', DIR)).toBeNull();
    expect(playwrightOutputCandidate('', DIR)).toBeNull();
    expect(playwrightOutputCandidate('.hidden.png', DIR)).toBeNull();
  });
});
