import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The line of `aigentron addon enable` that starts a bare-metal installer is run for real (with a fake `bash` that prints what it was given), in sh and in bash,
// with and without --stt-model: it once failed with «DATA_DIR=/opt/aigentron/data: not found» because the assignments were not at the start of the command.
const cli = readFileSync(join(import.meta.dirname, '../../../../infra/aigentron-cli.sh'), 'utf8');
const line = cli.split('\n').find((l) => /\bbash "\$dir\/bare\.sh" install/.test(l) && /DATA_DIR="\$DATA_DIR"/.test(l))!;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const run = (shell: string, sttModel: string): string => {
  const d = mkdtempSync(join(tmpdir(), 'cli-enable-'));
  dirs.push(d);
  writeFileSync(join(d, 'bash'), '#!/bin/sh\necho "args=$* BROWSER=$BROWSER CDP=$AGENT_CDP STT=$VOICE_STT MODEL=$WHISPER_MODEL DATA=$DATA_DIR"\n');
  chmodSync(join(d, 'bash'), 0o755);
  const script = `die() { echo "DIED: $*"; exit 1; }\nbrowser=chrome cdp=1 stt=on stt_model='${sttModel}' DATA_DIR=/opt/aigentron/data dir=/x extra=\n${line.trim()}\n`;
  return execFileSync(shell, ['-c', script], { env: { PATH: `${d}:${process.env.PATH}` }, encoding: 'utf8' }).trim();
};

describe('aigentron addon enable (bare-metal): starting the installer', () => {
  for (const shell of ['/bin/sh', '/bin/bash']) {
    it(`${shell}: the data dir and the options reach the installer, with and without a speech model`, () => {
      expect(run(shell, '')).toBe('args=/x/bare.sh install BROWSER=chrome CDP=1 STT=on MODEL= DATA=/opt/aigentron/data');
      expect(run(shell, 'small')).toContain('MODEL=small DATA=/opt/aigentron/data');
    });
  }
});
