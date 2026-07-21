---
name: translation
description: Bridges the human's language and the fleet's internal working language (English). Use whenever the human writes in a language other than English, or when preparing a human-facing summary.
---

# Skill: Translation
**Applies to:** all agents

---

## Purpose

Humans may communicate in any language via any channel. All internal agent work — code,
comments, commit messages, structured status reports, tool calls, delegation — is in English
regardless of the human's language. This skill defines the boundary.

## Rules

### Input (human's language → English)
- Understand the human's request in whatever language they used.
- Work, delegate, and reason internally in English.
- Do not silently guess a technical term with no clean equivalent — keep it in English if that's
  clearer, and say so.

### Output (English → human's language)
- Summaries and explanations directed at the human go in their language.
- Code, file paths, variable/function names, CLI commands, and TypeScript types stay in English
  — never translated.
- Keep untranslated the terms with no natural equivalent: API, endpoint, middleware, payload,
  token, hook, guard, DTO, and similar.

### What to translate vs keep in English

| Translate | Keep in English |
|-----------|------------------|
| Explanations and summaries | Code blocks |
| Status messages to the human | File paths |
| Error descriptions | Variable/function names |
| Review findings (human-facing summary) | CLI commands |
| Questions to the human | TypeScript types |
| Recommendations | Git commit messages |

## Agent output shape

Structure output so the human-facing part is clearly separated from the technical part:

```
## Summary (in the human's language)
[plain-language explanation of what was done]

## Code (English, unchanged)
```typescript
// code here
```

## Next steps (in the human's language)
[what happens next, or what's needed from the human]
```

The structured `report_task_status` tool call itself is always in English (see SOUL.md) — it is
consumed by the orchestrator, not read directly by the human.
