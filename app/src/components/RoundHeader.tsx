import { StyleSheet, Text, View } from 'react-native';
import type { ReceptionRow, Round, RoundState } from '../types';
import { colors, ui } from './styles';

const labels: Record<ReceptionRow['state'], string> = {
  received: '既読',
  pending: '保留',
  absent: '欠席',
  waived: '免除',
  transcribed_pending_attest: '保留・未検証',
};

type Props = { round: Round; phase: RoundState['phase']; rows: ReceptionRow[] };

export function RoundHeader({ round, phase, rows }: Props) {
  return (
    <View style={styles.header}>
      <View style={styles.separator}>
        <View style={styles.rule} />
        <Text accessibilityRole="header" style={ui.label}>ラウンド {round}</Text>
        <Text style={ui.chip}>{phase === 'frozen' ? '凍結' : '進行中'}</Text>
        <View style={styles.rule} />
      </View>
      {rows.length > 0 && (
        <View style={[ui.wrap, styles.chips]}>
          {rows.map(row => (
            <Text key={row.seat_id} style={[
              ui.chip,
              (row.state === 'pending' || row.state === 'transcribed_pending_attest') && ui.warning,
              row.state === 'absent' && ui.danger,
            ]}>
              {row.seat_id} · {labels[row.state]}
              {row.state === 'absent' && row.reason?.code ? `（${row.reason.code}）` : ''}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 8, paddingVertical: 8 },
  separator: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  chips: { justifyContent: 'center' },
});
