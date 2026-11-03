import { describe, expect, it } from 'vitest';
import { pageContent } from './page-content';

const U = '[untrusted] ';
describe('pageContent', () => {
  it('a normal page: its text, marked untrusted, no picture', async () => {
    const r = await pageContent({ tabId: 3, title: 'T', url: 'https://x.io', text: 'hello' }, U, async () => 'never');
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect((r.content[0] as { text: string }).text).toContain('Tab 3 — T (https://x.io)');
    expect((r.content[0] as { text: string }).text).toContain(`${U}hello`);
  });
  it('a page read from its source: the note is shown to the agent', async () => {
    const r = await pageContent({ text: 'src', note: 'This is the page SOURCE' }, U, async () => null);
    expect((r.content[0] as { text: string }).text).toContain('[This is the page SOURCE]');
  });
  it('a picture of an empty page is read by the vision model into text (the agent need not see images)', async () => {
    let asked = '';
    const r = await pageContent({ text: '', image: 'AAAA', note: 'n' }, U, async (_img, q) => ((asked = q), 'Rating 4.7 (2,105 reviews), 1,000,000 users'));
    expect(asked).toMatch(/exactly as shown/);
    expect(r.content).toHaveLength(1);
    expect((r.content[0] as { text: string }).text).toContain('Read from a screenshot of the page (by a vision model)');
    expect((r.content[0] as { text: string }).text).toContain('1,000,000 users');
  });
  it('without a vision model the picture itself goes to the agent', async () => {
    const r = await pageContent({ text: '', image: 'AAAA' }, U, async () => null);
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
    expect((r.content[0] as { text: string }).text).toContain('screenshot of the page is attached');
  });
});
