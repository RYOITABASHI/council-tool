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
