import { StyleSheet, Text, View } from 'react-native';
import type { DisplayStyle } from '../storage';
import type { ReceptionRow, Round, RoundState } from '../types';
import { lineHeightFor, useTheme } from './styles';

export const receptionLabels: Record<ReceptionRow['state'], string> = {
  received: '既読',
  pending: '保留',
  absent: '欠席',
  waived: '免除',
  transcribed_pending_attest: '保留・未検証',
};

type Props = { round: Round; phase: RoundState['phase']; rows: ReceptionRow[]; variant?: DisplayStyle };

/** Round separator styled like LINE's centered date pill (line) or a Slack date divider (slack). */
export function RoundHeader({ round, phase, rows, variant = 'line' }: Props) {
  const { colors, ui } = useTheme();
  const phaseLabel = phase === 'frozen' ? '凍結' : '進行中';
  const reception = rows.map(row => {
    const reason = row.state === 'absent' && row.reason?.code ? `（${row.reason.code}）` : '';
    return `${row.seat_id} ${receptionLabels[row.state]}${reason}`;
  }).join(' ・ ');
  const pill = (
    <View style={[styles.pill, { backgroundColor: colors.pill },
      variant === 'slack' && { backgroundColor: colors.chatBg, borderColor: colors.rail, borderWidth: StyleSheet.hairlineWidth }]}>
      <Text accessibilityRole="header" accessibilityLabel={`ラウンド ${round} ${phaseLabel}`} numberOfLines={1}
        style={[styles.label, { color: variant === 'slack' ? colors.ink : colors.pillInk }]}>
        {round} {phaseLabel}
      </Text>
    </View>
  );

  return (
    <View style={styles.header}>
      {variant === 'slack' ? (
        <View style={styles.divider}>
          <View style={[styles.rule, { backgroundColor: colors.rail }]} />
          {pill}
          <View style={[styles.rule, { backgroundColor: colors.rail }]} />
        </View>
      ) : pill}
      {/* The phase lives in the pill only; this line carries the reception table. */}
      {rows.length > 0 && <Text style={[ui.muted, styles.reception]}>{reception}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 4, paddingTop: 12, paddingBottom: 8 },
  divider: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  pill: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 4 },
  label: { fontSize: 12.5, lineHeight: lineHeightFor(12.5), fontWeight: '600', textAlign: 'center' },
  reception: { fontSize: 10.5, lineHeight: lineHeightFor(10.5), textAlign: 'center', paddingHorizontal: 16 },
});
