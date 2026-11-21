import { StyleSheet, Text, View } from 'react-native';
import type { ReceptionRow, Round, RoundState } from '../types';
import { useTheme } from './styles';

export const receptionLabels: Record<ReceptionRow['state'], string> = {
  received: '既読',
  pending: '保留',
  absent: '欠席',
  waived: '免除',
  transcribed_pending_attest: '保留・未検証',
};

type Props = { round: Round; phase: RoundState['phase']; rows: ReceptionRow[] };

export function RoundHeader({ round, phase, rows }: Props) {
  const { colors, ui } = useTheme();
  const reception = rows.map(row => {
    const reason = row.state === 'absent' && row.reason?.code ? `（${row.reason.code}）` : '';
    return `${row.seat_id} ${receptionLabels[row.state]}${reason}`;
  }).join(' ・ ');

  return (
    <View style={styles.header}>
      <View style={[styles.pill, { backgroundColor: colors.system }]}>
        <Text accessibilityRole="header" style={[ui.muted, styles.label]}>
          ラウンド {round} ・ {phase === 'frozen' ? '凍結' : '進行中'}
        </Text>
      </View>
      {rows.length > 0 && (
        <Text style={[ui.muted, styles.reception]}>{reception}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 4, paddingVertical: 6 },
  pill: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 3 },
  label: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  reception: { fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
