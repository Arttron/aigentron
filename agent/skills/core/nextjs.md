---
name: nextjs
description: Conventions, code patterns, and standards for building Next.js App Router pages and components — server/client components, API routes, CSS Modules structure. Use when writing or reviewing any Next.js frontend code.
---

# Skill: Next.js
**Applies to:** Frontend, Designer, Coder, Reviewer

---

## Project structure (App Router)

```
app/
├── (auth)/
│   ├── login/page.tsx
│   └── register/page.tsx
├── (dashboard)/
│   ├── layout.tsx
│   └── [feature]/
│       ├── page.tsx
│       └── [id]/page.tsx
├── api/
│   └── [route]/route.ts
├── layout.tsx
└── page.tsx

components/
├── ui/          # base components (Button, Input, Modal)
├── features/    # feature-specific components
└── layouts/     # headers, sidebars, navigation

lib/
├── api.ts       # fetch utilities
├── utils.ts
└── types.ts
```

## Code standards

### Server Component (default)
```typescript
// app/dashboard/users/page.tsx
import { getUsers } from '@/lib/api';

export default async function UsersPage() {
  const users = await getUsers(); // fetched server-side

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Users</h1>
      <UserList users={users} />
    </div>
  );
}
// styles from './page.module.css' — classes reference design tokens in globals.css
```

### Client Component (only when necessary)
```typescript
'use client';
// Only for: useState, useEffect, event handlers, browser APIs

import { useState } from 'react';

interface Props {
  initialValue: string;
}

export function SearchInput({ initialValue }: Props) {
  const [value, setValue] = useState(initialValue);

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className={styles.input}   // from './SearchInput.module.css'
    />
  );
}
```

### API Route
```typescript
// app/api/users/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Number(searchParams.get('page')) || 1;

    const res = await fetch(`${process.env.API_URL}/users?page=${page}`);
    const data = await res.json();

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
```

### Reusable component with CSS Modules
```typescript
// components/ui/Button.tsx
import { cn } from '@/lib/cn';
import styles from './Button.module.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ variant = 'primary', size = 'md', className, children, ...props }: ButtonProps) {
  return (
    <button className={cn(styles.base, styles[variant], styles[size], className)} {...props}>
      {children}
    </button>
  );
}
```
```css
/* components/ui/Button.module.css — colours/spacing come from tokens in globals.css */
.base { border-radius: var(--radius-sm); font-weight: 500; transition: background-color .15s; }
.base:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
.primary { background: var(--color-primary); color: var(--color-on-primary); }
.primary:hover { opacity: .9; }
.secondary { background: var(--color-surface); color: var(--color-on-surface); border: 1px solid var(--color-outline); }
.danger { background: var(--color-error); color: var(--color-on-error); }
.sm { padding: 6px 12px; font-size: 14px; }
.md { padding: 8px 16px; font-size: 16px; }
.lg { padding: 12px 24px; font-size: 18px; }
```

## Mandatory rules

- Server Components by default; `'use client'` only when necessary.
- `next/image` instead of `<img>` for all images.
- TypeScript interfaces for typing, no `any`.
- Environment variables only via `process.env`.
- Loading and error states for every async operation.
- `metadata` export on every page.
- Styling in CSS Modules (`*.module.css`) referencing tokens in `globals.css` — no Tailwind, no
  raw hex. `cn()` for combining/conditional class names.

## Environment variables

```
NEXT_PUBLIC_API_URL=   # available client-side
API_URL=                # server-only (backend URL)
NEXTAUTH_SECRET=
NEXTAUTH_URL=
```
