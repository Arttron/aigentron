import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeFrame } from './local-agent-proto';
import { noticeText, parseNotice, parseProposal, proposalPrompt } from './local-events';
import { LocalReactionsService } from './local-reactions.service';

const FIXTURES = join(__dirname, '../../../../packages/shared/protocol/local-agent');
const fixture = (f: string) => decodeFrame(readFileSync(join(FIXTURES, f), 'utf8'))!.data;

describe('events from a local agent', () => {
  it('the fixtures parse', () => {
    expect(parseNotice(fixture('event-notice.json'))).toEqual({
      repo: 'a1b2c3d4',
      kind: 'dirty',
      branch: 'main',
      minutes: 61,
      count: 3,
    });
    const p = parseProposal(fixture('event-propose-commit.json'))!;
    expect(p.files).toHaveLength(2);
    expect(p.idleMinutes).toBe(30);
  });

  it('refuses what is not shaped like an event, cuts and cleans what is', () => {
    expect(parseNotice(null)).toBeNull();
    expect(parseNotice({ repo: 'x', kind: 'nope' })).toBeNull();
    expect(parseNotice({ kind: 'dirty' })).toBeNull();
    expect(parseProposal({ repo: 'x', files: [] })).toBeNull();
    expect(parseProposal({ repo: 'x', files: 'a.txt' })).toBeNull();
    const n = parseNotice({
      repo: 'r',
      kind: 'behind',
      branch: 'ma\nin' + 'x'.repeat(500),
      minutes: -5,
      count: 1e12,
    })!;
    expect(n.branch).not.toContain('\n');
    expect(n.branch.length).toBeLessThanOrEqual(200);
    expect(n.minutes).toBe(0);
    expect(n.count).toBe(1_000_000);
    const many = parseProposal({
      repo: 'r',
      files: Array.from({ length: 200 }, (_, i) => ({ path: `f${i}`, xy: '??' })),
    })!;
    expect(many.files).toHaveLength(50);
  });

  it('writes the texts for people and for the agent', () => {
    const t = noticeText(
      { repo: 'r', kind: 'dirty', branch: 'main', minutes: 180, count: 4 },
      { project: 'Shop', computer: 'MacBook' },
    );
    expect(t).toContain('Shop');
    expect(t).toContain('MacBook');
    expect(t).toContain('3 h');
    expect(
      noticeText(
        { repo: 'r', kind: 'behind', branch: '', minutes: 40, count: 2 },
        { project: 'P', computer: 'C' },
      ),
    ).toContain('2 commit(s) behind');
    const prompt = proposalPrompt(parseProposal(fixture('event-propose-commit.json'))!, {
      computer: 'MacBook',
    });
    expect(prompt).toContain('src/a.go');
    expect(prompt).toContain('local_diff');
    expect(prompt).toMatch(/Do NOT try to commit/);
  });
});

function setup(bindings: Array<{ projectId: string; deviceId: string; repoId: string }>) {
  let hook: (d: string, n: string, data: unknown) => void = () => undefined;
  const bridge = { onEvent: (h: typeof hook) => (hook = h) };
  const notify = vi.fn(async () => true);
  const create = vi.fn(async () => ({ id: 't1' }));
  const projects = {
    getById: async (id: string) =>
      id === 'gone'
        ? { name: 'Old', slug: 'old', archivedAt: new Date() }
        : { name: `Project ${id}`, slug: `p-${id}`, archivedAt: null },
  };
  const svc = new LocalReactionsService(
    bridge as never,
    { list: () => bindings } as never,
    { list: () => [{ id: 'dev1', label: 'MacBook' }] } as never,
    projects as never,
    { notifyProject: notify } as never,
    { create } as never,
  );
  svc.onModuleInit();
  return { fire: hook, notify, create, svc };
}

describe('LocalReactionsService', () => {
  const b = [
    { projectId: 'A', deviceId: 'dev1', repoId: 'r1' },
    { projectId: 'B', deviceId: 'dev1', repoId: 'r2' },
    { projectId: 'gone', deviceId: 'dev1', repoId: 'r1' },
  ];

  it('a notice goes only to the projects bound to that repository on that computer', async () => {
    const { svc, notify } = setup(b);
    await svc.onNotice('dev1', {
      repo: 'r1',
      kind: 'dirty',
      minutes: 90,
      count: 2,
      branch: 'main',
    });
    expect(notify).toHaveBeenCalledTimes(1); // A only: B is another repository, "gone" is archived
    expect(notify.mock.calls[0]![0]).toBe('A');
    await svc.onNotice('other-device', { repo: 'r1', kind: 'dirty', minutes: 90, count: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('the same notice is not repeated within the hour; another kind is', async () => {
    const { svc, notify } = setup(b);
    const dirty = { repo: 'r1', kind: 'dirty', minutes: 90, count: 2 };
    await svc.onNotice('dev1', dirty);
    await svc.onNotice('dev1', dirty);
    await svc.onNotice('dev1', { ...dirty, kind: 'behind' });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('a proposal opens one task in the bound project, and not again soon', async () => {
    const { svc, create } = setup(b);
    const p = { repo: 'r1', branch: 'main', files: [{ path: 'a.go', xy: '.M' }], idleMinutes: 30 };
    await svc.onProposal('dev1', p);
    await svc.onProposal('dev1', p);
    expect(create).toHaveBeenCalledTimes(1);
    const dto = create.mock.calls[0]![0] as { prompt: string; project: string; title: string };
    expect(dto.project).toBe('p-A');
    expect(dto.prompt).toContain('a.go');
    expect(dto.title).toContain('Project A');
  });

  it('garbage and unbound repositories do nothing', async () => {
    const { svc, notify, create } = setup(b);
    await svc.onNotice('dev1', 'junk');
    await svc.onProposal('dev1', { repo: 'unbound', files: [{ path: 'x', xy: '' }] });
    await svc.onProposal('dev1', { repo: 'r1', files: [] });
    expect(notify).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
