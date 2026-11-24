import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useThemeColors } from '../components/styles';

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
        {/* The list and meeting screens draw their own thin LINE-style headers. */}
        <Stack.Screen name="index" options={{ title: 'セッション', headerShown: false }} />
        <Stack.Screen name="compose" options={{ title: '新規セッション' }} />
        <Stack.Screen name="meeting" options={{ title: '会議', headerShown: false }} />
        <Stack.Screen name="packet" options={{ title: '詳細', headerBackButtonDisplayMode: 'minimal' }} />
        <Stack.Screen name="settings" options={{ title: '設定' }} />
      </Stack>
    </>
  );
}
