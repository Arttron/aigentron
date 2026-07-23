import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';

const execFileAsync = promisify(execFile);

/**
 * Keeps platform-maintained files (the fleet charter SOUL.md, core skills) in
 * sync with the running release, WITHOUT clobbering local edits an operator
 * made on the deployed instance. Previously these were seeded ONCE on first
 * boot and never touched again — a code-level improvement (e.g. a better
 * SOUL.md) never reached an already-running instance short of manually SSHing
 * in and hand-patching the live file. Runs once per boot from here on.
 *
 * Per managed file, three-way compare: live (deployed, possibly hand-edited),
 * base (what was shipped last time this ran), shipped (what THIS release
 * ships).
 *   - live untouched since last sync (live === base) → straight overwrite,
 *     base advances to the new shipped content.
 *   - live customized, but shipped hasn't moved (shipped === base) → nothing
 *     to bring in; leave the customization alone.
 *   - live customized AND shipped changed → real three-way merge via
 *     `git merge-file` (the same algorithm git itself uses for a rebase). A
 *     clean merge applies automatically, after snapshotting the pre-merge
 *     live file; a genuine conflict is left untouched with a
 *     `<file>.merge-conflict` sibling for manual review — this never
 *     silently drops a local edit.
 *   - no recorded base yet (either truly first boot, or this mechanism is new
 *     and the file predates it) → adopt the CURRENT RELEASE's shipped content
 *     as the baseline WITHOUT touching live this boot (we don't know what
 *     version live was actually last edited against, so guess conservatively
 *     rather than bake an existing customization in as the new "unmodified"
 *     reference). Every later shipped change reconciles normally from there.
 *
 * Deliberately scoped to SOUL.md + skills/core/** — agent/agents/*.md are
 * user-owned from creation (edited via the Agents UI, no "shipped default"
 * concept to reconcile against) and skills/learned/* is agent-written with
 * its own approval/snapshot flow (SkillsLearnedService); neither belongs here.
 */
@Injectable()
export class AgentFilesSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentFilesSyncService.name);

  constructor(private readonly config: AppConfigService) {}

  async onApplicationBootstrap(): Promise<void> {
    // `full`/dev profile bind-mounts the SAME host `agent/` dir at two
    // different container paths (/workspace/agent AND /app/agent, for
    // hot-reload) — a string comparison of the two configured paths would
    // miss that, so compare by (device, inode) instead: identical real
    // directory → nothing to reconcile, and writing "shipped" back onto
    // itself would just pollute the git-tracked source tree with `.sync/`.
    if (await sameRealDir(this.config.agentDir, this.config.shippedAgentDir)) return;

    for (const rel of await this.managedFiles()) {
      await this.syncOne(rel).catch((err) =>
        this.logger.warn(`Sync skipped for ${rel}: ${(err as Error).message}`),
      );
    }
  }

  private async managedFiles(): Promise<string[]> {
    const out = ['SOUL.md'];
    const coreDir = join(this.config.shippedAgentDir, 'skills', 'core');
    try {
      const files = await readdir(coreDir, { recursive: true });
      for (const f of files) {
        if (f.toLowerCase().endsWith('.md')) out.push(join('skills', 'core', f));
      }
    } catch {
      /* no core skills dir shipped in this build — fine, nothing to sync */
    }
    return out;
  }

  private async syncOne(rel: string): Promise<void> {
    const shippedPath = join(this.config.shippedAgentDir, rel);
    const livePath = join(this.config.agentDir, rel);
    const basePath = join(this.config.agentDir, '.sync', 'base', rel);

    const shipped = await readOrNull(shippedPath);
    if (shipped === null) return; // this release ships nothing at this path — leave live alone

    const live = await readOrNull(livePath);
    if (live === null) {
      // New file as of this release (or never seeded) — adopt it, no merge needed.
      await writeManaged(livePath, shipped);
      await writeManaged(basePath, shipped);
      this.logger.log(`Seeded ${rel} (new)`);
      return;
    }

    const base = await readOrNull(basePath);
    if (base === null) {
      // We don't know what shipped version the live file was last edited
      // against, so treat THIS release's shipped content as the best-known
      // ancestor going forward — not the live content itself, which would
      // wrongly bake any existing customization in as the new "unmodified"
      // reference and let the very next sync silently overwrite it. Next
      // boot's live/base/shipped comparison then does the right thing
      // whether or not live already differs from shipped.
      await writeManaged(basePath, shipped);
      this.logger.log(`Adopted sync baseline for ${rel} (no change applied this boot)`);
      return;
    }

    if (live === base) {
      if (shipped !== live) {
        await writeManaged(livePath, shipped);
        this.logger.log(`Updated ${rel} to the shipped default`);
      }
      await writeManaged(basePath, shipped);
      return;
    }

    // Live has local edits since the last sync.
    if (shipped === base) return; // nothing new shipped — leave the customization alone

    const merged = await threeWayMerge(live, base, shipped);
    if (merged.conflict) {
      await writeManaged(`${livePath}.merge-conflict`, merged.text);
      this.logger.warn(
        `${rel} has local edits that conflict with a shipped update — see ` +
          `${rel}.merge-conflict for the attempted merge; resolve manually, then delete that file`,
      );
      return; // base intentionally left unchanged — retried every boot until resolved
    }

    await this.snapshot(rel, live);
    await writeManaged(livePath, merged.text);
    await writeManaged(basePath, shipped);
    this.logger.log(`Merged a shipped update into ${rel} (local edits preserved, no conflicts)`);
  }

  private async snapshot(rel: string, content: string): Promise<void> {
    const dir = join(this.config.agentDir, '.sync', 'snapshots');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${rel.replace(/[\\/]/g, '__')}.${stamp}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), content, 'utf8');
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function writeManaged(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** True if both paths resolve to the same real directory (same device+inode) —
 *  robust to two different bind-mount paths pointing at the same host dir. */
async function sameRealDir(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Three-way merge via `git merge-file` — reuses git's own merge algorithm
 * instead of hand-rolling one. `git merge-file --stdout <ours> <base> <theirs>`
 * merges base→theirs onto ours; a real conflict still exits non-zero but
 * still writes conflict-marker text to stdout, which we surface rather than
 * treat as a hard failure.
 */
async function threeWayMerge(
  ours: string,
  base: string,
  theirs: string,
): Promise<{ conflict: boolean; text: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'lds-merge-'));
  try {
    const oursPath = join(dir, 'ours');
    const basePath = join(dir, 'base');
    const theirsPath = join(dir, 'theirs');
    await Promise.all([
      writeFile(oursPath, ours, 'utf8'),
      writeFile(basePath, base, 'utf8'),
      writeFile(theirsPath, theirs, 'utf8'),
    ]);
    try {
      const { stdout } = await execFileAsync('git', ['merge-file', '--stdout', oursPath, basePath, theirsPath]);
      return { conflict: false, text: stdout };
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      if (typeof stdout === 'string' && stdout.length > 0) return { conflict: true, text: stdout };
      throw err;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
