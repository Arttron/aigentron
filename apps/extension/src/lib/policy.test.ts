import { describe, expect, it } from 'vitest';
import { DENY_HOSTS as SERVER_DENY, deniedReason as serverDenied } from '../../../orchestrator/src/browser-control/browser-policy';
// @ts-expect-error plain JS module of the extension
import { DENY_HOSTS, deniedReason, webUrl } from './policy.js';

describe('the extension keeps the same never-allowed list as the server', () => {
  it('the lists are identical', () => {
    expect([...DENY_HOSTS].sort()).toEqual([...SERVER_DENY].sort());
  });
  it('and judge every address alike', () => {
    const own = ['http://localhost:3088', 'https://aigentron.example.com'];
    for (const u of [
      'https://paypal.com', 'https://www.paypal.com/x', 'https://mail.google.com', 'https://github.com', 'https://example.com', 'https://mybank.example.com', 'https://notpaypal.example.org',
      'http://localhost:3088/settings', 'http://localhost:3000', 'https://aigentron.example.com/tasks', 'http://169.254.169.254/x', 'https://sub.accounts.google.com', 'https://evilstripe.com',
    ]) {
      expect(!!deniedReason(new URL(u), own), u).toBe(!!serverDenied(new URL(u), own));
    }
  });
  it('web addresses only', () => {
    expect(webUrl('https://Example.com/a')?.host).toBe('example.com');
    for (const bad of ['javascript:1', 'chrome://x', 'file:///x', 'https://u:p@x.io', '', null, 'nope']) expect(webUrl(bad as never), String(bad)).toBeNull();
  });
});
