/**
 * Colour values in chat text (#ff8800, rgb(255 136 0), hsl(30, 100%, 50%) …) are shown as a chip painted in that colour, with the text in black or
 * white — whichever reads better on it. Pure: the chip's CSS is rebuilt from the parsed numbers, never copied from the message.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + hh / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** One colour as written: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla() (comma or space syntax, alpha after `,` or `/`). Null if it is not one. */
export function parseColor(raw: string): Rgba | null {
  const s = raw.trim();
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 100) / 100 : 1 };
  }
  m = /^(rgba?|hsla?)\(\s*([^)]*?)\s*\)$/i.exec(s);
  if (!m) return null;
  const fn = m[1]!.toLowerCase();
  const parts = m[2]!.split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const num = (p: string, pct100: number) => {
    const isPct = p.endsWith('%');
    const v = Number(isPct ? p.slice(0, -1) : p.replace(/deg$/i, ''));
    return Number.isFinite(v) ? (isPct ? (v / 100) * pct100 : v) : NaN;
  };
  const alpha = parts[3] === undefined ? 1 : num(parts[3], 1);
  if (!Number.isFinite(alpha)) return null;
  const a = Math.round(clamp(alpha, 0, 1) * 100) / 100;
  if (fn.startsWith('rgb')) {
    const [r, g, b] = [num(parts[0]!, 255), num(parts[1]!, 255), num(parts[2]!, 255)];
    if ([r, g, b].some((x) => !Number.isFinite(x) || x < 0 || x > 255)) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }
  const h = num(parts[0]!, 360);
  const sat = num(parts[1]!, 1);
  const lig = num(parts[2]!, 1);
  if (![h, sat, lig].every(Number.isFinite) || !parts[1]!.endsWith('%') || !parts[2]!.endsWith('%')) return null;
  const [r, g, b] = hslToRgb(h, clamp(sat, 0, 1), clamp(lig, 0, 1));
  return { r, g, b, a };
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

/** Black or white text, whichever has the higher WCAG contrast ratio on the colour (a half-transparent colour is judged over white). */
export function contrastText(c: Rgba): '#000000' | '#ffffff' {
  const over = c.a >= 1 ? c : { r: c.r * c.a + 255 * (1 - c.a), g: c.g * c.a + 255 * (1 - c.a), b: c.b * c.a + 255 * (1 - c.a), a: 1 };
  const L = luminance(over);
  const onWhite = 1.05 / (L + 0.05);
  const onBlack = (L + 0.05) / 0.05;
  return onBlack >= onWhite ? '#000000' : '#ffffff';
}

/** The CSS colour for the chip background, rebuilt from the numbers. */
export const cssColor = (c: Rgba): string => (c.a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`);

export interface ColorSpan {
  start: number;
  end: number;
  text: string;
  color: Rgba;
}

const COLOR_RE = /(?<![\w&#/.-])(?:#[0-9a-f]{8}|#[0-9a-f]{6}|#[0-9a-f]{3,4}|(?:rgba?|hsla?)\(\s*[^()\n]{3,60}?\s*\))(?![\w-])/gi;

/**
 * Colours inside running text. A 3-4 digit hex must contain a letter (`#123` is an issue number, `#fa0` a colour); 6 and 8 digits are colours.
 * Not after a word character, `&` (an HTML entity), `/` or `.` (URLs, anchors, file names).
 */
export function findColors(text: string): ColorSpan[] {
  const out: ColorSpan[] = [];
  for (const m of text.matchAll(COLOR_RE)) {
    const t = m[0];
    if (/^#[0-9a-f]{3,4}$/i.test(t) && !/[a-f]/i.test(t)) continue;
    const color = parseColor(t);
    if (color) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + t.length, text: t, color });
  }
  return out;
}
