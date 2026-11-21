import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from './styles';

export function SeatAvatar({ seat }: { seat: string }) {
  const { colors, ui } = useTheme();
  let hash = 0;
  for (const letter of seat) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;

  return (
    <View style={[styles.avatar, { backgroundColor: `hsl(${hash % 360}, 55%, 86%)` }]} aria-hidden>
      <Text style={[ui.label, { color: colors.avatarInk }]}>{Array.from(seat)[0]?.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
