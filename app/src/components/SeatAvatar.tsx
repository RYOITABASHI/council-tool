import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from './styles';

type Props = { seat: string; size?: number; shape?: 'circle' | 'rounded' };

export function seatHue(seat: string): number {
  let hash = 0;
  for (const letter of seat) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function SeatAvatar({ seat, size = 40, shape = 'circle' }: Props) {
  const { colors, ui } = useTheme();
  const radius = shape === 'circle' ? size / 2 : Math.round(size * 0.22);

  return (
    <View style={[styles.avatar, {
      width: size, height: size, borderRadius: radius, backgroundColor: `hsl(${seatHue(seat)}, 55%, 86%)`,
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
