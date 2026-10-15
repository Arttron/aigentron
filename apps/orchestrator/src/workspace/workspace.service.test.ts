import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config/app-config.service';
import { WorkspaceService } from './workspace.service';

let base: string;
let svc: WorkspaceService;
const root = () => join(base, 'workspace');

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ws-'));
  await mkdir(join(base, 'attachments'), { recursive: true });
  svc = new WorkspaceService({ workspaceDir: root(), attachmentsDir: join(base, 'attachments') } as AppConfigService);
  await svc.ensureLayout();
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('WorkspaceService', () => {
  it('creates the layout once and never overwrites', async () => {
    expect((await readdir(root())).sort()).toEqual(['WORKSPACE.md', 'deliverables', 'memory', 'work']);
    await writeFile(join(root(), 'WORKSPACE.md'), 'my brief');
    await svc.ensureLayout();
    expect(await readFile(join(root(), 'WORKSPACE.md'), 'utf8')).toBe('my brief');
  });

  it('records notes, resolves questions, replaces status, shows them in the digest', async () => {
    await svc.note({ kind: 'question', text: 'Which battery?' }, 'pm');
    await svc.note({ kind: 'decision', text: 'Use ESP32' });
    expect(await svc.note({ kind: 'decision', text: 'Battery: 18650', resolves: 'which battery' })).toContain('marked answered');
    await svc.note({ kind: 'status', text: 'Phase 2' });
    await svc.note({ kind: 'status', text: 'Phase 3' });
    const digest = await svc.digest();
    expect(digest).toContain('Use ESP32');
    expect(digest).toContain('Phase 3');
    expect(digest).not.toContain('Phase 2');
    expect(digest).not.toContain('Which battery?'); // answered → not listed as open
    expect(await readFile(join(root(), 'memory', 'questions.md'), 'utf8')).toContain('- [x]');
  });

  it('rejects bad notes', async () => {
    await expect(svc.note({ kind: 'nope', text: 'x' })).rejects.toThrow(/kind/);
    await expect(svc.note({ kind: 'fact', text: '  ' })).rejects.toThrow(/empty/);
    await expect(svc.note({ kind: 'fact', text: 'x'.repeat(2001) })).rejects.toThrow(/too long/);
  });

  it('an untouched workspace adds nothing to the prompt', async () => {
    expect(await svc.digest()).toBe('');
  });

  it('keeps only the newest 5 earlier versions of a deliverable, and drops those older than 90 days', async () => {
    await svc.save({ path: 'a.md', content: 'v0' });
    const vdir = join(root(), 'deliverables', '.versions');
    await mkdir(vdir, { recursive: true });
    await writeFile(join(vdir, 'a.md.2020-01-01T00-00-00-000Z'), 'ancient');
    await writeFile(join(vdir, 'other.md.2020-01-01T00-00-00-000Z'), 'someone else\'s');
    for (let i = 1; i <= 8; i++) {
      await svc.save({ path: 'a.md', content: `v${i}` });
      await new Promise((r) => setTimeout(r, 3)); // distinct timestamps
    }
    const kept = (await readdir(vdir)).filter((n) => n.startsWith('a.md.'));
    expect(kept).toHaveLength(5);
    expect(kept).not.toContain('a.md.2020-01-01T00-00-00-000Z');
    expect((await readdir(vdir)).includes('other.md.2020-01-01T00-00-00-000Z')).toBe(true); // other files' history is not touched
  });

  it('copies `from` only out of the given task attachments folder, not another task\'s', async () => {
    await mkdir(join(base, 'attachments', 'tA'), { recursive: true });
    await mkdir(join(base, 'attachments', 'tB'), { recursive: true });
    await writeFile(join(base, 'attachments', 'tA', 'a.txt'), 'mine');
    await writeFile(join(base, 'attachments', 'tB', 'b.txt'), 'theirs');
    const mine = join(base, 'attachments', 'tA');
    await expect(svc.save({ path: 'x.txt', from: join(mine, 'a.txt') }, [], undefined, mine)).resolves.toContain('Saved');
    await expect(svc.save({ path: 'y.txt', from: join(base, 'attachments', 'tB', 'b.txt') }, [], undefined, mine)).rejects.toThrow(/not available/);
  });

  it('saves into deliverables, keeps the previous version, refuses escapes', async () => {
    expect(await svc.save({ path: 'reports/a.md', content: 'v1' })).toContain('Saved');
    expect(await svc.save({ path: 'reports/a.md', content: 'v2' })).toContain('previous version was kept');
    expect(await readFile(join(root(), 'deliverables', 'reports', 'a.md'), 'utf8')).toBe('v2');
    expect((await readdir(join(root(), 'deliverables', '.versions', 'reports'))).length).toBe(1);
    for (const path of ['../x', '/etc/x', '.versions/x', 'a/../../x']) await expect(svc.save({ path, content: 'x' })).rejects.toThrow(/relative path/);
    await expect(svc.save({ path: 'a.md' })).rejects.toThrow(/either/);
    await expect(svc.save({ path: 'a.md', content: 'x', from: '/x' })).rejects.toThrow(/either/);
    // a symlinked folder inside deliverables must not lead out
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root(), 'deliverables', 'link'));
    await expect(svc.save({ path: 'link/x.md', content: 'x' })).rejects.toThrow(/leaves deliverables/);
  });

  it('treats an empty `from` / `content` as not given', async () => {
    expect(await svc.save({ path: 'e.md', content: 'text', from: '' })).toContain('Saved');
    await writeFile(join(base, 'attachments', 'x.txt'), 'x');
    expect(await svc.save({ path: 'x.txt', content: '', from: join(base, 'attachments', 'x.txt') })).toContain('Saved');
  });

  it('copies only files of the task (attachments / allowed roots)', async () => {
    await writeFile(join(base, 'attachments', 'plan.pdf'), 'pdf');
    await writeFile(join(base, 'secret.txt'), 'nope');
    expect(await svc.save({ path: 'plan.pdf', from: join(base, 'attachments', 'plan.pdf') })).toContain('Saved');
    await expect(svc.save({ path: 's.txt', from: join(base, 'secret.txt') })).rejects.toThrow(/not available/);
    expect(await svc.save({ path: 's.txt', from: join(base, 'secret.txt') }, [base]).catch((e) => e.message)).toContain('Saved');
    await expect(svc.save({ path: 'p.txt', from: 'relative/p.txt' })).rejects.toThrow(/full path/);
  });

  it('never copies a sign-in token or env file into deliverables, even from an allowed root', async () => {
    // a chat agent's allowed roots used to be the whole agent dir — runs/*/codex-home holds live Codex tokens
    const agentDir = join(base, 'agent');
    for (const rel of ['runs/t1/codex-home/auth.json', 'runs/t1/codex-home/sessions/s.jsonl', '.codex-home/auth.json', 'runs/t1/codex-home/generated_images/pic.png', 'runs/t1/.env', 'runs/t1/notes.txt']) {
      await mkdir(join(agentDir, rel, '..'), { recursive: true });
      await writeFile(join(agentDir, rel), 'x');
    }
    for (const rel of ['runs/t1/codex-home/auth.json', 'runs/t1/codex-home/sessions/s.jsonl', '.codex-home/auth.json', 'runs/t1/.env']) {
      await expect(svc.save({ path: 'out.txt', from: join(agentDir, rel) }, [agentDir]), rel).rejects.toThrow(/not available/);
    }
    expect(await svc.save({ path: 'pic.png', from: join(agentDir, 'runs/t1/codex-home/generated_images/pic.png') }, [agentDir])).toContain('Saved');
    expect(await svc.save({ path: 'notes.txt', from: join(agentDir, 'runs/t1/notes.txt') }, [agentDir])).toContain('Saved');
    // a symlink inside an allowed root that points at a token: the real path is checked too
    await symlink(join(agentDir, '.codex-home', 'auth.json'), join(base, 'attachments', 'innocent.json'));
    await expect(svc.save({ path: 'i.json', from: join(base, 'attachments', 'innocent.json') })).rejects.toThrow(/not available/);
  });

  it('lists files with dir and glob filters, hides internals', async () => {
    await writeFile(join(root(), 'work', 'a.md'), 'a');
    await writeFile(join(root(), 'work', 'b.txt'), 'b');
    await svc.save({ path: 'r.md', content: 'x' });
    await svc.save({ path: 'r.md', content: 'y' });
    const all = await svc.files();
    expect(all).toContain('work/a.md');
    expect(all).toContain('deliverables/r.md');
    expect(all).not.toContain('.versions');
    expect(await svc.files({ dir: 'work', glob: '*.md' })).not.toContain('b.txt');
    expect(await svc.files({ dir: 'work', glob: '*.pdf' })).toContain('No files');
  });

  it('records an ask_user answer as a decision and never throws', async () => {
    await svc.recordAnswer('Which colour?', 'Blue');
    expect(await readFile(join(root(), 'memory', 'decisions.md'), 'utf8')).toContain('[asked the person] Which colour? → Blue');
    await expect(svc.recordAnswer('', '')).resolves.toBeUndefined();
  });

  it('serialises concurrent notes', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => svc.note({ kind: 'fact', text: `f${i}` })));
    const lines = (await readFile(join(root(), 'memory', 'facts.md'), 'utf8')).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(20);
  });

  describe('dashboard access', () => {
    it('lists the root and folders, hides dotfiles and foreign entries', async () => {
      await writeFile(join(root(), 'stray.txt'), 'x');
      await svc.save({ path: 'a.md', content: 'x' });
      const top = await svc.list('');
      expect(top.entries.map((e) => e.name).sort()).toEqual(['WORKSPACE.md', 'deliverables', 'memory', 'work']);
      const d = await svc.list('deliverables');
      expect(d.entries.map((e) => e.name)).toEqual(['a.md']); // .versions / .log.md hidden
      expect(d.writable).toBe(false);
      expect((await svc.list('work')).writable).toBe(true);
    });

    it('refuses paths outside the three folders, hidden parts and symlinks out', async () => {
      for (const p of ['../x', '/etc', '.git', 'stray.txt', 'secrets/x', 'work/../memory/../../x']) await expect(svc.list(p), p).rejects.toThrow();
      const outside = join(base, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'k.txt'), 'secret');
      await symlink(outside, join(root(), 'work', 'link'));
      await expect(svc.fileForServing('work/link/k.txt')).rejects.toThrow(/leaves the workspace/);
      await expect(svc.writeUpload('work/link/new.txt', Readable.from(['x']))).rejects.toThrow(/leaves the workspace/);
    });

    it('serves text inline as text/plain, images inline, anything else as a download', async () => {
      await writeFile(join(root(), 'work', 'n.md'), '# hi');
      await writeFile(join(root(), 'work', 'p.html'), '<script>1</script>');
      await writeFile(join(root(), 'work', 'i.png'), 'png');
      expect(await svc.fileForServing('work/n.md')).toMatchObject({ mime: 'text/plain; charset=utf-8', inline: true, text: true });
      expect(await svc.fileForServing('work/p.html')).toMatchObject({ inline: false, mime: 'application/octet-stream' });
      expect(await svc.fileForServing('work/i.png')).toMatchObject({ inline: true, mime: 'image/png' });
      await expect(svc.fileForServing('work/none.md')).rejects.toThrow(/Not found/);
    });

    it('accepts uploads only into work/ and the brief, with a size limit for the brief', async () => {
      expect(await svc.writeUpload('work/sub/new.txt', Readable.from([Buffer.from('hello')]))).toEqual({ path: 'work/sub/new.txt', size: 5 });
      expect(await readFile(join(root(), 'work', 'sub', 'new.txt'), 'utf8')).toBe('hello');
      await svc.writeUpload('WORKSPACE.md', Readable.from([Buffer.from('# Goal: x')]));
      expect(await readFile(join(root(), 'WORKSPACE.md'), 'utf8')).toBe('# Goal: x');
      for (const p of ['deliverables/x.txt', 'memory/decisions.md', 'work']) await expect(svc.writeUpload(p, Readable.from(['x'])), p).rejects.toThrow();
      await expect(svc.writeUpload('WORKSPACE.md', Readable.from([Buffer.alloc(70 * 1024)]))).rejects.toThrow(/too large/);
      expect((await readdir(root())).some((n) => n.includes('.part-'))).toBe(false);
    });

    it('deletes files in work/ and deliverables/ only', async () => {
      await writeFile(join(root(), 'work', 'x.txt'), 'x');
      await svc.save({ path: 'r.md', content: 'x' });
      await svc.remove('work/x.txt');
      await svc.remove('deliverables/r.md');
      await expect(svc.remove('memory/decisions.md')).rejects.toThrow(/only in work/);
      await expect(svc.remove('WORKSPACE.md')).rejects.toThrow(/only in work/);
      await expect(svc.remove('work')).rejects.toThrow();
    });

    it('summarises sizes per folder', async () => {
      await writeFile(join(root(), 'work', 'x.txt'), '12345');
      const s = await svc.summary();
      expect(s.folders.work).toEqual({ files: 1, bytes: 5 });
      expect(s.bytes).toBeGreaterThanOrEqual(5);
    });
  });
});
