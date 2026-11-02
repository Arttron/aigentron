/** `0.1.104` vs `0.1.99` → 1 / 0 / -1 (numeric parts; a missing part is 0). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Is `available` (the server's extension version) newer than the installed one? An unknown version never triggers an update. */
export const updateAvailable = (installed, available) => Boolean(installed && available) && /^\d/.test(String(available)) && compareVersions(available, installed) > 0;
