// CSS Modules: `import styles from './X.module.css'` → a class-name map.
// Next handles the real transform; this only satisfies a bare `tsc --noEmit`.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Plain side-effect CSS imports (e.g. globals.css).
declare module '*.css';
