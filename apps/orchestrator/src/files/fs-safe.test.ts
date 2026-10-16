import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insideRoot, isSecretPath, realAncestorInside, realInside, realRoots, safeName } from './fs-safe';

describe('insideRoot (pure)', () => {
  const roots = ['/data/attachments', '/data/agent/resources/'];
  it('accepts paths under a root, by whole segments', () => {
    expect(insideRoot('/data/attachments/t1/video.mp4', roots)).toBe(true);
    expect(insideRoot('/data/attachments', roots)).toBe(true);
    expect(insideRoot('/data/agent/resources/files/a.jpg', roots)).toBe(true);
    expect(insideRoot('/data/attachmentsX/a', roots)).toBe(false);
    expect(insideRoot('/data/secrets/auth.json', roots)).toBe(false);
  });
  it('refuses `..` anywhere', () => {
    expect(insideRoot('/data/attachments/../secrets/auth.json', roots)).toBe(false);
    expect(insideRoot('/data/attachments/t1/..', roots)).toBe(false);
  });
  it('an empty root never allows everything', () => {
    expect(insideRoot('/etc/passwd', [''])).toBe(false);
    expect(insideRoot('/etc/passwd', ['/'])).toBe(false); // "/" normalises to '' — never a usable root
    expect(insideRoot('/a/b', ['', '/a'])).toBe(true);
  });
  it('unicode segments are ordinary', () => {
    expect(insideRoot('/data/attachments/t1/кухня 2.jpg', roots)).toBe(true);
  });
});

describe('realInside / realAncestorInside (symlinks)', () => {
  let base: string;
  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'fss-')));
    await mkdir(join(base, 'root', 'sub'), { recursive: true });
    await mkdir(join(base, 'outside'));
    await writeFile(join(base, 'root', 'sub', 'f.txt'), 'f');
    await writeFile(join(base, 'outside', 'secret.txt'), 's');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  it('a real file inside resolves; a symlink out of the root does not; a symlink inside does', async () => {
    const root = join(base, 'root');
    expect(await realInside(join(root, 'sub', 'f.txt'), [root], { file: true })).toBe(join(root, 'sub', 'f.txt'));
    await symlink(join(base, 'outside', 'secret.txt'), join(root, 'leak.txt'));
    expect(await realInside(join(root, 'leak.txt'), [root])).toBeNull();
    await symlink(join(root, 'sub', 'f.txt'), join(root, 'alias.txt'));
    expect(await realInside(join(root, 'alias.txt'), [root])).toBe(join(root, 'sub', 'f.txt'));
    await symlink(join(base, 'outside'), join(root, 'dirlink'));
    expect(await realInside(join(root, 'dirlink', 'secret.txt'), [root])).toBeNull();
  });
  it('a root that is a symlink is compared by its real path; `file` refuses folders; missing paths are null', async () => {
    await symlink(join(base, 'root'), join(base, 'rootlink'));
    expect(await realInside(join(base, 'rootlink', 'sub', 'f.txt'), [join(base, 'rootlink')])).toBe(join(base, 'root', 'sub', 'f.txt'));
    expect(await realInside(join(base, 'root', 'sub'), [join(base, 'root')], { file: true })).toBeNull();
    expect(await realInside(join(base, 'root', 'sub'), [join(base, 'root')])).toBe(join(base, 'root', 'sub'));
    expect(await realInside(join(base, 'root', 'none.txt'), [join(base, 'root')])).toBeNull();
  });
  it('empty roots and `..` never open anything', async () => {
    expect(await realInside(join(base, 'outside', 'secret.txt'), [''])).toBeNull();
    expect(await realInside(`${base}/root/../outside/secret.txt`, [join(base, 'root')])).toBeNull();
    expect(await realRoots(['', join(base, 'root'), join(base, 'nope')])).toEqual([join(base, 'root'), join(base, 'nope')]);
  });
  it('an upload target that does not exist yet is judged by its deepest existing ancestor', async () => {
    const root = join(base, 'root');
    expect(await realAncestorInside(join(root, 'sub', 'new', 'deep.txt'), [root])).toBe(true);
    await symlink(join(base, 'outside'), join(root, 'sub', 'link'));
    expect(await realAncestorInside(join(root, 'sub', 'link', 'new.txt'), [root])).toBe(false);
    expect(await realAncestorInside(join(base, 'outside', 'x.txt'), [root])).toBe(false);
  });
});

describe('safeName', () => {
  it('keeps unicode, drops paths, dots and odd characters', () => {
    expect(safeName('кухня 2.jpg')).toBe('кухня 2.jpg');
    expect(safeName('写真.PNG')).toBe('写真.PNG');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..')).toBe('file');
    expect(safeName('.links.json')).toBe('links.json');
    expect(safeName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(safeName('x'.repeat(200))).toHaveLength(120);
  });
});

describe('isSecretPath', () => {
  it('spots tokens and env files anywhere, but allows codex generated images', () => {
    expect(isSecretPath('/a/runs/t/codex-home/auth.json')).toBe(true);
    expect(isSecretPath('/a/runs/t/codex-home/generated_images/x.png')).toBe(false);
    expect(isSecretPath('/a/runs/t/codex-home/skills/x')).toBe(true);
    expect(isSecretPath('/ws/.env.local')).toBe(true);
    expect(isSecretPath('/ws/work/x.md')).toBe(false);
  });
});
