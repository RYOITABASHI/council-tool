import { StyleSheet, Text, View } from 'react-native';

type Props = { seat: string; size?: number; shape?: 'circle' | 'rounded' };

/**
 * Saturated avatar fills (Slack's default-avatar grammar: a strong colour field with white bold
 * initials). Every entry keeps white text at a contrast of at least 4.9:1. The entries run around
 * the hue circle in order, about 30° apart. Sibling seats step 5 entries (about 150° of hue), so
 * codex-a and codex-b sit on clearly different hues; 5 is coprime with the length (12), so up to
 * twelve seats sharing a stem (codex-a, codex-b, …) all land on different colours; further siblings
 * reuse the hues in other shades (see `shadeTiers`).
 */
export const seatPalette = [
  '#C0392B', // red
  '#C2410C', // orange
  '#A35C00', // amber
  '#4D7C0F', // olive
  '#15803D', // green
  '#0F766E', // teal
  '#0E7490', // cyan
  '#1D4ED8', // blue
  '#4338CA', // indigo
  '#7E22CE', // purple
  '#A21CAF', // fuchsia
  '#BE185D', // pink
] as const;

const siblingStep = 5;

/** A seat ID split into its stem and a trailing short suffix (codex-a → codex + a, gpt_2 → gpt + 2, web3 → web + 3). */
function splitSeat(seat: string): { stem: string; separator: string; suffix?: string } {
  const separated = /^(.*[^-_\s])([-_\s])([A-Za-z0-9]{1,2})$/.exec(seat);
  if (separated) return { stem: separated[1], separator: separated[2], suffix: separated[3] };
  const numbered = /^(.*\D)(\d{1,2})$/.exec(seat);
  if (numbered) return { stem: numbered[1], separator: '', suffix: numbered[2] };
  return { stem: seat, separator: '' };
}

// FNV-1a over code points. The offset basis is XOR-ed with a fixed seed, chosen once so that the
// usual seat sets — claude / codex / web, and codex-a / codex-b / web — land at least 90° of hue
// apart within each set. Any seat ID still gets a fixed colour; the seed only picks which fixed mapping.
const hashSeed = 89;

function hash(text: string): number {
  let value = (0x811c9dc5 ^ hashSeed) >>> 0;
  for (const character of text) {
    value ^= character.codePointAt(0)!;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Position of a suffix in its sequence: a → 0, b → 1, …; 1 → 1, 2 → 2, …; two characters in base 36. */
function suffixOrdinal(suffix: string): number {
  if (/^\d+$/.test(suffix)) return Number(suffix);
  if (/^[a-z]$/i.test(suffix)) return parseInt(suffix, 36) - 10;
  return Array.from(suffix.toLowerCase()).reduce((sum, character) => sum * 36 + parseInt(character, 36), 0);
}

/**
 * Shade tiers for siblings past one palette cycle. A family's suffixes walk the palette in steps of
 * `siblingStep`; after every twelve siblings the walk starts over on the same hues, so each further
 * cycle draws those hues in another shade: darker, desaturated, or both. `lightness` is added to the
 * HSL lightness and `saturation` scales the HSL saturation. Tiers never lighten, and `shade` darkens
 * further until white initials keep at least 4.5:1, so every tier stays as legible as the base.
 */
const shadeTiers = [
  { lightness: 0, saturation: 1 },
  { lightness: -0.12, saturation: 1 },
  { lightness: -0.02, saturation: 0.45 },
  { lightness: -0.12, saturation: 0.45 },
] as const;

/** Lowest HSL lightness a tier may reach, so dark tiers stay coloured instead of turning black. */
const lightnessFloor = 0.14;

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]: [number, number, number]): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function contrastWithWhite(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

const shadeCache = new Map<string, string>();

/** The palette entry drawn in the given shade tier (tier 0 is the entry itself). */
function shade(hex: string, tier: number): string {
  const { lightness, saturation } = shadeTiers[tier % shadeTiers.length];
  if (lightness === 0 && saturation === 1) return hex;
  const key = `${hex}:${tier % shadeTiers.length}`;
  const cached = shadeCache.get(key);
  if (cached) return cached;
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  let target = Math.max(lightnessFloor, l + lightness);
  let rgb = hslToRgb([h, s * saturation, target]);
  while (contrastWithWhite(rgb) < 4.5 && target > lightnessFloor) {
    target = Math.max(lightnessFloor, target - 0.02);
    rgb = hslToRgb([h, s * saturation, target]);
  }
  const result = rgbToHex(rgb);
  shadeCache.set(key, result);
  return result;
}

/**
 * One colour per seat, derived from the whole seat ID and shared by the session-list collage, the
 * meeting avatars and the mention candidates. Seats with the same stem are spread by their suffix,
 * so codex-a and codex-b never share a colour; siblings a whole palette cycle apart (codex-a and
 * codex-m) share a hue but are drawn in different shade tiers, so the first 48 siblings of a
 * family all get different colours (four cycles; the tiers repeat after that).
 */
export function seatColor(seat: string): string {
  const { stem, separator, suffix } = splitSeat(seat);
  const ordinal = suffix === undefined ? 0 : suffixOrdinal(suffix);
  // The separator is part of the family key, so codex-1 and codex_1 (distinct IDs that share
  // initials) are hashed as different families instead of being forced onto the same colour.
  const index = (hash(stem.toLowerCase() + separator) + ordinal * siblingStep) % seatPalette.length;
  return shade(seatPalette[index], Math.floor(ordinal / seatPalette.length));
}

/** Initials: the first character of the stem, upper-cased, plus the suffix if any (codex-a → Ca). */
export function seatInitials(seat: string): string {
  const { stem, suffix } = splitSeat(seat);
  const first = Array.from(stem)[0]?.toUpperCase() ?? '';
  return suffix === undefined ? first : first + suffix.toLowerCase();
}

/** Font size for initials in a box of the given size: two-character initials get a smaller face. */
export function initialsFontSize(initials: string, size: number, minimum = 11): number {
  const ratio = Array.from(initials).length > 1 ? 0.34 : 0.42;
  return Math.max(minimum, Math.round(size * ratio));
}

export function SeatAvatar({ seat, size = 40, shape = 'circle' }: Props) {
  const radius = shape === 'circle' ? size / 2 : Math.round(size * 0.22);
  const initials = seatInitials(seat);

  return (
    <View style={[styles.avatar, {
      width: size, height: size, borderRadius: radius, backgroundColor: seatColor(seat),
    }]} aria-hidden>
      <Text numberOfLines={1} style={[styles.initials, { fontSize: initialsFontSize(initials, size) }]}>
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // Stretches across the avatar so the initials are never boxed to their exact measured width.
  initials: { alignSelf: 'stretch', textAlign: 'center', color: '#FFFFFF', fontWeight: '800', includeFontPadding: false },
});
