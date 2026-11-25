import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from './styles';

type Props = { seat: string; size?: number; shape?: 'circle' | 'rounded' };

const seatColors = ['#D2EDE2', '#F6DECE', '#E7DEF8', '#DCEAFB', '#F6E3F0', '#F8ECC9'];

/** One colour per seat, shared by the session list collage and the meeting avatars. */
export function seatColor(seat: string): string {
  let hash = 0;
  for (const character of seat) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return seatColors[hash % seatColors.length];
}

export function SeatAvatar({ seat, size = 40, shape = 'circle' }: Props) {
  const { colors, ui } = useTheme();
  const radius = shape === 'circle' ? size / 2 : Math.round(size * 0.22);

  return (
    <View style={[styles.avatar, {
      width: size, height: size, borderRadius: radius, backgroundColor: seatColor(seat),
    }]} aria-hidden>
      <Text style={[ui.label, { color: colors.avatarInk, fontSize: Math.max(11, Math.round(size * 0.4)) }]}>
        {Array.from(seat)[0]?.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
});
