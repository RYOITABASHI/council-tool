const leadLimit = 280;

export function statementLead(statement: string) {
  const [first, ...rest] = statement.trim().split(/\r?\n(?:[^\S\r\n]*\r?\n)+/);
  const characters = Array.from(first.trimEnd());
  if (characters.length <= leadLimit) return { text: first.trimEnd(), hasMore: rest.length > 0 };

  const capped = characters.slice(0, leadLimit);
  const sentenceEnd = capped.findLastIndex(character => /[。！？]/.test(character));
  return {
    text: capped.slice(0, sentenceEnd < 0 ? leadLimit : sentenceEnd + 1).join('') + '…',
    hasMore: true,
  };
}

/** Lines a lead may show in a bubble / thread post before it is cut (whole lines, ending in "…"). */
export const leadLines = 8;

/**
 * Full-width characters per line of lead text at the narrowest width the app is laid out for, with
 * the system font scale at 1. Worked from a 320dp-wide screen and the line-style bubble (the
 * narrower of the two styles): list padding 2×10, avatar 40 + gap 8, row padding 8 → column 244;
 * bubble capped at 84% → 205, minus its 5 + 2×13 padding → about 174dp of text at 15.5dp, which is
 * 11 full-width glyphs. One glyph of slack is taken off for line-breaking rules (kinsoku) that push
 * a character to the next line. Thread-style posts are wider (about 14 glyphs even as replies).
 */
export const narrowestLineCharacters = 10;

/** Characters per line at the narrowest width for the given system font scale (never below 4). */
export function narrowestPerLine(fontScale = 1): number {
  return Math.max(4, Math.floor(narrowestLineCharacters / Math.max(1, fontScale)));
}

/**
 * Whether a lead may need more than `lines` lines. Deliberately pessimistic (the narrowest line from
 * `narrowestPerLine`; half-width characters count as about half), so a lead that gets cut offers the
 * detail link even before its layout is measured; a false "may" only shows the link on a lead that
 * happened to fit. The bubble also measures the real layout (onTextLayout), which catches widths and
 * fonts this estimate does not foresee.
 */
export function mayExceedLines(text: string, lines = leadLines, perLine = narrowestPerLine()): boolean {
  let total = 0;
  for (const paragraph of text.split(/\r?\n/)) {
    let width = 0;
    for (const character of paragraph) width += character.codePointAt(0)! < 0x2e80 ? 0.55 : 1;
    total += Math.max(1, Math.ceil(width / perLine));
    if (total > lines) return true;
  }
  return false;
}

/**
 * Whether a laid-out lead was cut, from the lines its onTextLayout reported. Platforms report either
 * every line of the text or only the visible ones, so a layout that reaches the line limit counts as
 * cut (a lead that fills exactly `lines` lines may show the link without needing it — the safe side).
 */
export function layoutWasCut(reportedLines: number, lines = leadLines): boolean {
  return reportedLines >= lines;
}
