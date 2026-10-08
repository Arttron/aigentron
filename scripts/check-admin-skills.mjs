#!/usr/bin/env node
/**
 * Drift check: the admin agent only knows its tools from agent/skills/core/admin/admin-tools.md, so every admin tool
 * defined in code must be documented there (and nothing documented may be missing from the code). Also checks that the
 * admin's frontmatter lists both reference skills. Run: `node scripts/check-admin-skills.mjs` (exit 1 on drift).
 */
import { readFileSync } from 'node:fs';

const code = readFileSync('packages/agent-runner/src/internal-tools.ts', 'utf8');
const doc = readFileSync('agent/skills/core/admin/admin-tools.md', 'utf8');
const admin = readFileSync('agent/builtin/admin.md', 'utf8');

// Tool names registered inside the `if (params.admin)` block.
const block = code.slice(code.indexOf('if (params.admin)'));
const inCode = [...block.matchAll(/^\s+name: '([a-z_]+)'/gm)].map((m) => m[1]);
// Tool names documented as `name` in table rows.
const inDoc = new Set([...doc.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]));

const missingInDoc = inCode.filter((n) => !inDoc.has(n));
const staleInDoc = [...inDoc].filter((n) => !inCode.includes(n));
const skillsLine = admin.match(/^skills:\s*(.+)$/m)?.[1] ?? '';
const skillsOk = ['admin-tools', 'dashboard-guide'].every((s) => skillsLine.includes(s));

let bad = false;
if (missingInDoc.length) { bad = true; console.error(`admin-tools.md is missing: ${missingInDoc.join(', ')}`); }
if (staleInDoc.length) { bad = true; console.error(`admin-tools.md documents tools that no longer exist: ${staleInDoc.join(', ')}`); }
if (!skillsOk) { bad = true; console.error('agent/builtin/admin.md must list "admin-tools, dashboard-guide" in skills:'); }
console.log(bad ? 'DRIFT detected' : `OK — ${inCode.length} admin tools documented, skills wired`);
process.exit(bad ? 1 : 0);
