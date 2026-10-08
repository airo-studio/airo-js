/**
 * Colour lowering for the Lynx encoder: `color-mix()` and the CSS Color 4
 * functions become sRGB at build time, because the engine parses neither
 * (the spike's probes: both paint the fallback grey). That holds for tokens
 * read through `var()` as well: the spike saw `oklch()` tokens resolve only
 * because rsbuild's lightningcss-loader had already turned them into hex,
 * and only for a browserslist that lacks `oklch()`.
 *
 * `color-mix()` follows CSS Color 5 §2: percentages normalised, colours
 * converted into the interpolation space, alpha premultiplied, hue by the
 * shorter arc unless the call names another method, and the alpha scaled
 * when the percentages sum to less than 100%.
 */

import { converter, parse, type Color } from 'culori';

import { splitTopLevel, UnresolvableValueError } from './values.js';

/** CSS `color-mix()` interpolation spaces → culori modes. */
const SPACES: Record<string, { mode: string; hue: string | null }> = {
  srgb: { mode: 'rgb', hue: null },
  'srgb-linear': { mode: 'lrgb', hue: null },
  'display-p3': { mode: 'p3', hue: null },
  lab: { mode: 'lab', hue: null },
  oklab: { mode: 'oklab', hue: null },
  xyz: { mode: 'xyz65', hue: null },
  'xyz-d65': { mode: 'xyz65', hue: null },
  'xyz-d50': { mode: 'xyz50', hue: null },
  hsl: { mode: 'hsl', hue: 'h' },
  hwb: { mode: 'hwb', hue: 'h' },
  lch: { mode: 'lch', hue: 'h' },
  oklch: { mode: 'oklch', hue: 'h' },
};

type Channels = Record<string, number>;

const CHANNELS: Record<string, string[]> = {
  rgb: ['r', 'g', 'b'],
  lrgb: ['r', 'g', 'b'],
  p3: ['r', 'g', 'b'],
  lab: ['l', 'a', 'b'],
  oklab: ['l', 'a', 'b'],
  xyz65: ['x', 'y', 'z'],
  xyz50: ['x', 'y', 'z'],
  hsl: ['h', 's', 'l'],
  hwb: ['h', 'w', 'b'],
  lch: ['l', 'c', 'h'],
  oklch: ['l', 'c', 'h'],
};

/** Parse a colour that has no `var()` and no `color-mix()` left in it. */
export function parseColour(text: string): Color {
  const colour = parse(text.trim());
  if (!colour) throw new UnresolvableValueError(`"${text.trim()}" is not a colour the build can read`, text);
  return colour;
}

function interpolateHue(a: number, b: number, t: number, method: string): number {
  let delta = b - a;
  if (method === 'shorter') {
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
  } else if (method === 'longer') {
    if (delta > 0 && delta < 180) delta -= 360;
    else if (delta > -180 && delta <= 0) delta += 360;
  } else if (method === 'increasing') {
    if (delta < 0) delta += 360;
  } else if (method === 'decreasing') {
    if (delta > 0) delta -= 360;
  }
  return (((a + delta * t) % 360) + 360) % 360;
}

const PCT = /^(-?\d*\.?\d+)%$/;

/** One `<color> <percentage>?` argument; the percentage may come first or last. */
function colourArg(text: string): { colour: string; pct: number | null } {
  const words = splitTopLevel(text, ' ');
  const first = PCT.exec(words[0] ?? '');
  const last = PCT.exec(words[words.length - 1] ?? '');
  if (first) return { colour: words.slice(1).join(' '), pct: Number(first[1]) };
  if (last) return { colour: words.slice(0, -1).join(' '), pct: Number(last[1]) };
  return { colour: text.trim(), pct: null };
}

/**
 * Evaluate the inside of a `color-mix(...)` call. `evalColour` turns each
 * colour argument into a culori colour, so nested mixes and tokens resolve
 * before mixing.
 */
export function mixColours(inner: string, evalColour: (text: string) => Color): Color {
  const args = splitTopLevel(inner, ',');
  if (args.length !== 3) throw new UnresolvableValueError(`color-mix() needs three arguments, got "${inner}"`, inner);
  const spec = /^in\s+([a-z0-9-]+)(?:\s+(shorter|longer|increasing|decreasing)\s+hue)?$/i.exec(args[0]!.trim());
  const space = spec && SPACES[spec[1]!.toLowerCase()];
  if (!spec || !space) throw new UnresolvableValueError(`color-mix() space "${args[0]}" is not supported`, inner);
  const hueMethod = (spec[2] ?? 'shorter').toLowerCase();

  const a = colourArg(args[1]!);
  const b = colourArg(args[2]!);
  let p1 = a.pct;
  let p2 = b.pct;
  if (p1 === null && p2 === null) [p1, p2] = [50, 50];
  else if (p1 === null) p1 = 100 - p2!;
  else if (p2 === null) p2 = 100 - p1;
  const sum = p1 + p2!;
  if (sum <= 0) throw new UnresolvableValueError(`color-mix() percentages sum to ${sum}%`, inner);
  const alphaScale = sum < 100 ? sum / 100 : 1;
  const t = p2! / sum;

  const toSpace = converter(space.mode as Parameters<typeof converter>[0]);
  const c1 = toSpace(evalColour(a.colour)) as unknown as Channels & { alpha?: number };
  const c2 = toSpace(evalColour(b.colour)) as unknown as Channels & { alpha?: number };
  const a1 = c1.alpha ?? 1;
  const a2 = c2.alpha ?? 1;
  const alpha = a1 * (1 - t) + a2 * t;

  const out: Channels = {};
  for (const ch of CHANNELS[space.mode]!) {
    const v1 = c1[ch];
    const v2 = c2[ch];
    if (ch === space.hue) {
      // A missing hue (an achromatic colour, or `transparent`) takes the other's.
      const h1 = Number.isFinite(v1) ? v1! : v2;
      const h2 = Number.isFinite(v2) ? v2! : v1;
      out[ch] = Number.isFinite(h1) && Number.isFinite(h2) ? interpolateHue(h1!, h2!, t, hueMethod) : 0;
      continue;
    }
    const x1 = Number.isFinite(v1) ? v1! : 0;
    const x2 = Number.isFinite(v2) ? v2! : 0;
    // Premultiplied: each channel weighted by its colour's alpha, then divided back out.
    const premixed = x1 * a1 * (1 - t) + x2 * a2 * t;
    out[ch] = alpha === 0 ? 0 : premixed / alpha;
  }
  return { ...out, mode: space.mode, alpha: alpha * alphaScale } as unknown as Color;
}

const toRgb = converter('rgb');
const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255);

/**
 * sRGB in the legacy comma syntax, which every Lynx release parses:
 * `rgb(165, 208, 70)`, or `rgba(…, 0.12)` when not opaque. Out-of-gamut
 * channels are clipped, which is what a browser shows on an sRGB display.
 */
export function formatSrgb(colour: Color): string {
  const rgb = toRgb(colour);
  const alpha = Math.round((rgb.alpha ?? 1) * 1000) / 1000;
  const channels = `${byte(rgb.r)}, ${byte(rgb.g)}, ${byte(rgb.b)}`;
  return alpha >= 1 ? `rgb(${channels})` : `rgba(${channels}, ${alpha})`;
}
