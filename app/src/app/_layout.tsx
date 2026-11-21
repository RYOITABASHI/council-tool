import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '../components/styles';

function SettingsButton() {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="設定"
      onPress={() => router.push('/settings')} style={styles.gear}>
      <Text style={styles.icon}>⚙</Text>
    </Pressable>
  );
}

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{
        title: '首脳会議',
        headerTintColor: colors.ink,
        headerStyle: { backgroundColor: colors.white },
        contentStyle: { backgroundColor: colors.page },
      }}>
        <Stack.Screen name="index" options={{ title: 'セッション', headerRight: SettingsButton }} />
        <Stack.Screen name="meeting" options={{ title: '会議', headerRight: SettingsButton }} />
        <Stack.Screen name="settings" options={{ title: '設定' }} />
      </Stack>
    </>
  );
}


const styles = StyleSheet.create({
  gear: {
    width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  icon: { color: colors.ink, fontSize: 22 },
});
