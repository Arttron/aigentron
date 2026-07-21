---
name: code-intel
description: Semantic code navigation via the `code-intel` MCP server (Serena) — find symbols, their definitions and references, and file symbol overviews instead of grepping and reading whole files. Use before changing existing code you don't fully know.
---

# Skill: Code Intelligence (via the `code-intel` MCP server)
**Applies to:** Architect, Backend, Frontend, Coder, Designer, Reviewer

`code-intel` is a semantic code toolkit (Serena) exposed as `mcp__code-intel__*`. It understands
the code as symbols (functions, classes, methods) with definitions and references — so you can
navigate precisely instead of reading whole files or grepping blindly. It requires the server to
be in your `mcp:` list; if the tools aren't available, fall back to `Read`/`Grep` and say so.

## When to use it

Use `code-intel` **before editing existing code you don't already understand**:
- "Where is this defined / what calls it?" → jump to the symbol and its references, don't grep.
- "What's in this file?" → get a symbol overview before reading 500 lines.
- "What will my change break?" → list referencing symbols before you touch a signature.

For brand-new files, or a quick one-liner in code you already have open, plain `Read`/`Edit` is
fine — don't force the tool where it adds nothing.

## Tools

| Tool | Purpose |
|------|---------|
| `mcp__code-intel__get_symbols_overview` | top-level symbols in a file/dir — the map before you dive in. |
| `mcp__code-intel__find_symbol` | locate a symbol's definition by name/path (precise, no grep). |
| `mcp__code-intel__find_referencing_symbols` | every call site of a symbol — check blast radius before changing a signature. |
| `mcp__code-intel__search_for_pattern` | semantic/regex search across the project when you don't know the symbol name yet. |

Typical loop before a change:

```
get_symbols_overview   → understand the module's shape
find_symbol            → read the exact definition you'll change
find_referencing_symbols → see who depends on it, so you update call sites too
… then Edit …
```

## Project activation

The server auto-activates your working directory as the project on startup
(`--project-from-cwd`), so the tools above work immediately. If any tool ever
returns **"No active project"**, activate it once before retrying:

```
mcp__code-intel__activate_project   { project: "<your working directory>" }
```

Then re-run the navigation call. You only need to do this once per session.

## Rules

- **Understand before you change** (SOUL principle 1) — for a change to existing code, do the
  navigation above first and state, in one line, what the symbol does and who uses it.
- Prefer symbol-level navigation over reading entire files — it's faster and keeps your context
  focused on what matters.
- Read-only navigation (`get_symbols_overview`, `find_symbol`, `find_referencing_symbols`,
  `search_for_pattern`, `read_file`, `list_dir`) runs without approval; symbol **writes**
  (`replace_symbol_body`, `insert_*`) and any shell tool the server exposes are approval-gated.
  Still, navigate deliberately rather than firing many exploratory calls.
- Reviewer/PM stay read-only — use `code-intel` to *inspect* symbols and references; never to
  edit (that's for the implementer agents).
