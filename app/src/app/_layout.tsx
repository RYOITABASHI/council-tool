import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../components/styles';

function SettingsButton() {
  const colors = useThemeColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="設定"
      onPress={() => router.push('/settings')} style={styles.gear}>
      <Text style={[styles.icon, { color: colors.ink }]}>⚙</Text>
    </Pressable>
  );
}

function SessionButtons() {
  const colors = useThemeColors();
  return (
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel="新規セッション"
        onPress={() => router.push('/compose')} style={styles.gear}>
        <Text style={[styles.icon, { color: colors.ink }]}>＋</Text>
      </Pressable>
      <SettingsButton />
    </View>
  );
}

export default function RootLayout() {
  const colors = useThemeColors();
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{
        title: '首脳会議',
        headerTintColor: colors.ink,
        headerStyle: { backgroundColor: colors.header },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.page },
      }}>
        <Stack.Screen name="index" options={{ title: 'セッション', headerRight: SessionButtons }} />
        <Stack.Screen name="compose" options={{ title: '新規セッション' }} />
        <Stack.Screen name="meeting" options={{ title: '会議', headerRight: SettingsButton }} />
        <Stack.Screen name="settings" options={{ title: '設定' }} />
      </Stack>
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  gear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 22 },
});
