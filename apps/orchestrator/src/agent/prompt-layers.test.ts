import { describe, expect, it } from 'vitest';
import { assemblePromptLayers, projectMapBlock, withRunContext } from './prompt-layers';

const base = {
  orientation: '## Your workspace\n- working directory: `/w/t1`\n- branch: `agent/t1`',
  instructions: '# SOUL\nBe brief.\n\n# Skill: x.md\n…',
  roster: '\n\n## Your colleagues\n- coder: writes code — Task tool',
};

describe('prompt layers (E-04: the system append must be cacheable across runs)', () => {
  it('the system append does not depend on the project map or the memory digest', () => {
    const a = assemblePromptLayers({ ...base, projectMap: 'README.md\nsrc/a.ts', memory: '## Workspace memory\n- decided: X' });
    const b = assemblePromptLayers({ ...base, projectMap: 'README.md\nsrc/a.ts\nsrc/new-file.ts', memory: '## Workspace memory\n- decided: X\n- decided: Y' });
    const c = assemblePromptLayers({ ...base, projectMap: '', memory: '' });
    expect(a.systemAppend).toBe(b.systemAppend);
    expect(a.systemAppend).toBe(c.systemAppend);
    expect(a.systemAppend).not.toContain('Project map');
    expect(a.systemAppend).not.toContain('Workspace memory');
    // and it still carries the static layers, in order
    expect(a.systemAppend.indexOf('## Your workspace')).toBeLessThan(a.systemAppend.indexOf('# SOUL'));
    expect(a.systemAppend.indexOf('# SOUL')).toBeLessThan(a.systemAppend.indexOf('## Your colleagues'));
  });

  it('the map and the memory go into the run context, map first', () => {
    const l = assemblePromptLayers({ ...base, projectMap: 'README.md\nsrc/a.ts', memory: '## Workspace memory\n- decided: X' });
    expect(l.runContext).toContain('## Project map');
    expect(l.runContext).toContain('src/a.ts');
    expect(l.runContext.indexOf('## Project map')).toBeLessThan(l.runContext.indexOf('## Workspace memory'));
    expect(assemblePromptLayers({ ...base, projectMap: '', memory: '' }).runContext).toBe('');
    expect(projectMapBlock('  \n')).toBe('');
  });

  it('the run context is prepended to the message and separated from it; an empty one changes nothing', () => {
    expect(withRunContext('Fix the bug', '')).toBe('Fix the bug');
    const m = withRunContext('Fix the bug', '## Project map\n```\na.ts\n```');
    expect(m.startsWith('## Project map')).toBe(true);
    expect(m.endsWith('\n\n---\n\nFix the bug')).toBe(true);
  });
});
