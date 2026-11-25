import { StyleSheet, Text, View } from 'react-native';
import type { MeetingState } from '../types';
import { useTheme } from './styles';

const labels: Record<MeetingState, string> = {
  CREATED: '作成済み',
  OPEN: '進行中',
  BARRIER: '受付締切',
  GATE: '議長判定中',
  SYNTHESIZING: '統合中',
  AWAITING_APPROVAL: '承認待ち',
  APPROVED: '承認済み',
  REJECTED: '却下',
};

export function StateBanner({ state, canApprove = false }: { state: MeetingState; canApprove?: boolean }) {
  const { ui } = useTheme();
  const awaiting = state === 'AWAITING_APPROVAL';
  return (
    <View style={[ui.wrap, styles.banner]}>
      <Text numberOfLines={1} style={[
        ui.chip,
        (awaiting || state === 'GATE' || state === 'BARRIER') && ui.warning,
        state === 'REJECTED' && ui.danger,
      ]}>{labels[state]}</Text>
      {awaiting && !canApprove && <Text style={ui.muted}>承認待ち（この画面からは承認できません）</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { alignItems: 'center' },
});
