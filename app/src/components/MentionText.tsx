import type { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native';
import { useTheme } from './styles';

const mentionPattern = /[@＠]([^\s@＠、。,.!?！？]+)/g;

/** Returns the first `@seat` token in the text that names a known seat. */
export function mentionedSeat(text: string, seatIds: readonly string[]): string | undefined {
  for (const match of text.matchAll(mentionPattern)) {
    if (seatIds.includes(match[1])) return match[1];
  }
  return undefined;
}

/** Body text with `@seat` mentions highlighted Slack-style. */
export function MentionText({ text, seatIds, style }: {
  text: string; seatIds: readonly string[]; style?: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  const parts: (string | { seat: string; raw: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(mentionPattern)) {
    if (!seatIds.includes(match[1])) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push({ seat: match[1], raw: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <Text selectable style={style}>
      {parts.map((part, index) => typeof part === 'string' ? part : (
        <Text key={index} style={{
          color: colors.mention, backgroundColor: colors.mentionBackground, fontWeight: '600',
        }}>{part.raw}</Text>
      ))}
    </Text>
  );
}
