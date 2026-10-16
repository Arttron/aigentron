#!/usr/bin/env node
/**
 * Drift check: the admin agent only knows its tools from agent/skills/core/admin/admin-tools.md, so every admin tool
 * defined in code must be documented there (and nothing documented may be missing from the code). Also checks that the
 * admin's frontmatter lists both reference skills. Run: `node scripts/check-admin-skills.mjs` (exit 1 on drift).
 */
import { readFileSync, readdirSync } from 'node:fs';

// The agent runtime cuts every skill file at this many CHARACTERS (SKILL_FILE_CAP in apps/orchestrator/src/agent/real-agent-executor.ts);
// anything past it is silently invisible to the admin agent.
const SKILL_FILE_CAP = 16_000;
const ADMIN_SKILLS_DIR = 'agent/skills/core/admin';

const code = readFileSync('packages/agent-runner/src/internal-tools.ts', 'utf8');
const doc = readFileSync('agent/skills/core/admin/admin-tools.md', 'utf8');
const admin = readFileSync('agent/builtin/admin.md', 'utf8');

// Tool names registered inside the `if (params.admin)` block.
const block = code.slice(code.indexOf('if (params.admin)'));
const inCode = [...block.matchAll(/^\s+name: '([a-z_]+)'/gm)].map((m) => m[1]);
// General tools every agent has (e.g. resources_search) may also be documented for the admin.
const anyTool = new Set([...code.matchAll(/^\s+name: '([a-z_]+)'/gm)].map((m) => m[1]));
// Tool names documented as `name` in table rows.
const inDoc = new Set([...doc.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]));

const missingInDoc = inCode.filter((n) => !inDoc.has(n));
const staleInDoc = [...inDoc].filter((n) => !anyTool.has(n));
const skillsLine = admin.match(/^skills:\s*(.+)$/m)?.[1] ?? '';
const skillsOk = ['admin-tools', 'dashboard-guide'].every((s) => skillsLine.includes(s));

let bad = false;
for (const f of readdirSync(ADMIN_SKILLS_DIR).filter((n) => n.endsWith('.md')).sort()) {
  // String#length (UTF-16 units) is what the runtime cuts by — an emoji counts 2
  const chars = readFileSync(`${ADMIN_SKILLS_DIR}/${f}`, 'utf8').length;
  if (chars > SKILL_FILE_CAP) {
    bad = true;
    console.error(`${ADMIN_SKILLS_DIR}/${f} is ${chars} characters, over the ${SKILL_FILE_CAP}-character per-file cap (SKILL_FILE_CAP) - the agent would not see the last ${chars - SKILL_FILE_CAP}. Trim it or split it into another file.`);
  }
}
if (missingInDoc.length) { bad = true; console.error(`admin-tools.md is missing: ${missingInDoc.join(', ')}`); }
if (staleInDoc.length) { bad = true; console.error(`admin-tools.md documents tools that no longer exist: ${staleInDoc.join(', ')}`); }
if (!skillsOk) { bad = true; console.error('agent/builtin/admin.md must list "admin-tools, dashboard-guide" in skills:'); }
console.log(bad ? 'DRIFT detected' : `OK — ${inCode.length} admin tools documented, skills wired`);
process.exit(bad ? 1 : 0);
