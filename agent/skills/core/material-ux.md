---
name: material-ux
description: Material Design 3 as a decision framework, implemented with CSS Modules + CSS custom-property design tokens (this project uses CSS Modules, NOT Tailwind) — color roles, typography, elevation, shape, interaction states, motion. Use when designing or building any UI component or page.
---

# Skill: Material Design 3 (M3) with CSS Modules
**Applies to:** Designer, Frontend

---

## Core principle

M3 is a design system, not a component library. Use it as a decision framework for spacing,
elevation, motion, and interaction states. Do **not** install `@mui/material`, and do **not** use
Tailwind — this project styles with **CSS Modules** (`*.module.css` per component) plus **CSS
custom properties** (design tokens) declared once in `globals.css`.

## Color system — semantic roles as tokens (`globals.css`)

```css
:root {
  --color-primary: #6750A4;
  --color-on-primary: #FFFFFF;
  --color-primary-container: #EADDFF;
  --color-surface: #FFFBFE;
  --color-on-surface: #1C1B1F;
  --color-outline: #79747E;
  --color-error: #B3261E;
  --color-on-error: #FFFFFF;
}
[data-theme="dark"] {
  --color-primary: #D0BCFF;
  --color-surface: #1C1B1F;
  --color-on-surface: #E6E1E5;
}
```

Reference roles via `var(--color-…)` in module CSS — **never a raw hex value in a component**.

## Shape scale — radius tokens, never arbitrary radius

```css
:root {
  --radius-xs: 4px;      /* chips, inputs      */
  --radius-sm: 8px;      /* cards, menus       */
  --radius-md: 12px;     /* dialogs            */
  --radius-lg: 16px;     /* bottom sheets      */
  --radius-full: 9999px; /* FAB, avatar, badge */
}
```

Use `border-radius: var(--radius-sm)` — never `border-radius: 7px`.

## Button — variants in a CSS Module

```css
/* Button.module.css */
.base {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-width: 64px; height: 40px; padding: 0 24px;
  border-radius: var(--radius-full); font: 500 14px/1 inherit;
  transition: all .15s cubic-bezier(0.2, 0, 0, 1);
}
.base:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.base:disabled { opacity: .38; cursor: not-allowed; }

.filled   { background: var(--color-primary); color: var(--color-on-primary); }
.filled:hover { opacity: .9; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
.tonal    { background: var(--color-primary-container); color: var(--color-on-surface); }
.outlined { background: transparent; color: var(--color-primary); border: 1px solid var(--color-outline); }
.text     { background: transparent; color: var(--color-primary); }
```

```tsx
import { cn } from '@/lib/cn';
import styles from './Button.module.css';
// <button className={cn(styles.base, styles[variant])} />
```

## Interaction states — every interactive element needs all of these

| State | Implementation (module CSS) |
|-------|------------------------------|
| Default | base class |
| Hover | `:hover` — subtle opacity/background shift |
| Focus | `:focus-visible { outline: 2px solid var(--color-primary) }` |
| Pressed | `:active` |
| Disabled | `:disabled { opacity: .38; cursor: not-allowed }` |

## Motion

Durations 50–400ms (micro-interactions shortest, page transitions longest); easing
`cubic-bezier(0.2, 0, 0, 1)`; keep under 400ms. If reused, define `--motion-*` tokens.

## Layout grid

| Breakpoint | Columns | Margin | Gutter |
|-----------|---------|--------|--------|
| Mobile (<600px) | 4 | 16px | 16px |
| Tablet (600–904px) | 8 | 32px | 24px |
| Desktop (>904px) | 12 | auto | 24px |

Implement with CSS grid + media queries inside the component's module CSS.

## Rules

### Designer (advisory)
- Specify M3 color roles and which token each element uses — never raw hex.
- Every interactive element has all interaction states.
- Shape from the radius scale — no arbitrary values.
- Light and dark mode both defined.

### Frontend
- One `*.module.css` per component; reference `var(--color-…)` / radius / spacing tokens —
  never hardcode colours, never Tailwind utilities.
- Reuse `@/components/ui/` primitives — don't re-style a button inline.
- `:disabled` and `:focus-visible` on every interactive element.

### Reviewer
- No hardcoded hex colours — tokens only.
- All interactive elements have hover / focus / active / disabled.
- Border radius follows the shape scale.
- Dark mode covered.
