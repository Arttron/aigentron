/**
 * ASCII file names for stored files. A name like "кухня 2.jpg" is stored as "kukhnya-2.jpg" and the original is kept next to it
 * (a names map), so people always see what they uploaded while shells, git, URLs, macOS/Linux unicode normalisation and the
 * models' tool calls only ever meet plain ASCII paths.
 */

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Ukrainian, Belarusian, Serbian, Macedonian
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ђ: 'dj', ј: 'j', љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz', ѓ: 'gj', ќ: 'kj', ѕ: 'dz',
};
const GREEK: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r',
  σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};
const LATIN_EXTRA: Record<string, string> = { ł: 'l', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

function translitChar(ch: string): string {
  const lower = ch.toLowerCase();
  const map = CYR[lower] ?? GREEK[lower] ?? LATIN_EXTRA[lower];
  if (map === undefined) {
    // an accented Greek/Latin letter (ά, é): strip the accent and look again
    const bare = ch.normalize('NFD').replace(/[\u0300-\u0345]/g, '');
    return bare !== ch && bare.length === 1 ? translitChar(bare) : ch;
  }
  return ch === lower ? map : map.charAt(0).toUpperCase() + map.slice(1);
}

/** ASCII-only version of a file name: transliterates Cyrillic/Greek, strips Latin diacritics, drops scripts it cannot read (→ "file" when nothing is left). */
export function asciiFileName(name: string): string {
  const normalised = name.normalize('NFC');
  const dot = normalised.lastIndexOf('.');
  const hasExt = dot > 0 && dot < normalised.length - 1;
  const rawBase = hasExt ? normalised.slice(0, dot) : normalised;
  const rawExt = hasExt ? normalised.slice(dot + 1) : '';
  const clean = (s: string): string =>
    Array.from(s)
      .map(translitChar)
      .join('')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '');
  const base = clean(rawBase).slice(0, 100) || 'file';
  const ext = clean(rawExt).slice(0, 12); // case kept: lookups are case-insensitive, and an ASCII name stays exactly what was uploaded
  return ext ? `${base}.${ext}` : base;
}

/** True when the stored name differs from what the person called the file (so the original is worth remembering). */
export const needsOriginal = (stored: string, original: string): boolean => stored !== original;
