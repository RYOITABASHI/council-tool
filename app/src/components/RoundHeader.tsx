import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DisplayStyle } from '../storage';
import type { ReceptionRow, Round, RoundState } from '../types';
import { lineHeightFor, useTheme } from './styles';

export const receptionLabels: Record<ReceptionRow['state'], string> = {
  received: '既読',
  pending: '保留',
  absent: '欠席',
  waived: '棄権',
  transcribed_pending_attest: '保留・未検証',
};

/** Japanese labels for the reason codes a waived / absent row carries; unknown codes show as is. */
const reasonCodeLabels: Record<string, string> = {
  execution_error: '実行エラー',
  execution_timeout: '時間切れ',
  output_overflow: '出力超過',
  unparseable_output: '出力を解釈できず',
};

export function reasonLabel(code: string): string {
  return Object.hasOwn(reasonCodeLabels, code) ? reasonCodeLabels[code] : code;
}

/** What each round is for: R0 first answers, R1 mutual critique, R2 reconsideration, later rounds extra. */
export function roundPurpose(round: Round): string {
  if (round === 'R0') return '初回回答';
  if (round === 'R1') return '相互批評';
  if (round === 'R2') return '再検討';
  return '追加ラウンド';
}

/**
 * The collapsed reception line: "回答済み n/m席", then every waived or absent seat by name, so an
 * abstention is never hidden behind the count.
 */
export function receptionSummary(rows: ReceptionRow[]): string {
  const answered = rows.filter(row => row.state === 'received').length;
  const parts = [`回答済み ${answered}/${rows.length}席`];
  for (const row of rows) {
    if (row.state === 'waived' || row.state === 'absent') parts.push(`${row.seat_id} ${receptionLabels[row.state]}`);
  }
  return parts.join(' ・ ');
}

type Props = { round: Round; phase: RoundState['phase']; rows: ReceptionRow[]; variant?: DisplayStyle };

/**
 * Round separator styled like LINE's centered date pill (line) or a Slack date divider (slack). The
 * pill names the round and its purpose plus the phase; under it, a one-line reception summary that a
 * tap on the header expands into one row per seat (with the reason for a waived / absent seat).
 */
export function RoundHeader({ round, phase, rows, variant = 'line' }: Props) {
  const { colors, ui } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const phaseLabel = phase === 'frozen' ? '凍結' : '進行中';
  const purpose = roundPurpose(round);
  const summary = rows.length > 0 ? receptionSummary(rows) : '';
  const flagged = rows.some(row => row.state === 'waived' || row.state === 'absent');
  const pillInk = variant === 'slack' ? colors.ink : colors.pillInk;

  // No numberOfLines: the pill sizes to its whole label (and may wrap) rather than being cut to "R".
  const pill = (
    <View style={[styles.pill, { backgroundColor: colors.pill },
      variant === 'slack' && { backgroundColor: colors.chatBg, borderColor: colors.rail, borderWidth: StyleSheet.hairlineWidth }]}>
      <Text style={[styles.label, { color: pillInk }]}>
        <Text style={styles.round}>{round}</Text>
        {` ${purpose}`}
        <Text style={styles.phase}>{` ・ ${phaseLabel}`}</Text>
      </Text>
    </View>
  );

  const heading = variant === 'slack' ? (
    <View style={styles.divider}>
      <View style={[styles.rule, { backgroundColor: colors.rail }]} />
      {pill}
      <View style={[styles.rule, { backgroundColor: colors.rail }]} />
    </View>
  ) : pill;

  if (rows.length === 0) {
    return (
      <View style={styles.header} accessible accessibilityRole="header"
        accessibilityLabel={`ラウンド ${round} ${purpose} ${phaseLabel}`}>
        {heading}
      </View>
    );
  }

  return (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
        accessibilityLabel={`ラウンド ${round} ${purpose} ${phaseLabel}。${summary}`}
        accessibilityHint={expanded ? '受理状況の内訳を閉じる' : '受理状況の内訳を開く'}
        onPress={() => setExpanded(value => !value)}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}>
        {heading}
        {/* The summary spans the header's width, so it is never boxed to its exact measured width. */}
        <Text style={[ui.muted, styles.summary, flagged && { color: colors.amber }]}>
          {summary}
          <Text style={{ color: colors.muted }}>{expanded ? '  ︿' : '  ﹀'}</Text>
        </Text>
      </Pressable>
      {expanded && (
        <View style={[styles.rows, { borderColor: colors.rail }]}>
          {rows.map(row => {
            const reason = (row.state === 'waived' || row.state === 'absent') && row.reason ? row.reason : null;
            return (
              <View key={row.seat_id} style={styles.row}>
                <Text style={[ui.muted, styles.rowText]}>
                  <Text style={{ color: colors.ink, fontWeight: '600' }}>{row.seat_id}</Text>
                  {`  ${receptionLabels[row.state]}`}
                  {reason?.code ? `：${reasonLabel(reason.code)}` : ''}
                </Text>
                {/* The raw facade text only supplements the Japanese label. */}
                {!!reason?.text?.trim() && (
                  <Text selectable style={[ui.muted, styles.rawReason]}>{reason.text.trim()}</Text>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: 4, paddingTop: 12, paddingBottom: 8 },
  toggle: { alignSelf: 'stretch', alignItems: 'center', gap: 4, borderRadius: 8, paddingVertical: 2 },
  pressed: { opacity: 0.6 },
  divider: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  // LINE's date pill: dark grey, light text at about 11dp. Slack's divider pill: same size, outlined.
  pill: { flexShrink: 0, maxWidth: '92%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 3 },
  label: { fontSize: 11.5, lineHeight: lineHeightFor(11.5), fontWeight: '600', textAlign: 'center' },
  round: { fontWeight: '800' },
  phase: { fontWeight: '400' },
  summary: {
    alignSelf: 'stretch', fontSize: 11.5, lineHeight: lineHeightFor(11.5), textAlign: 'center', paddingHorizontal: 16,
  },
  rows: {
    alignSelf: 'stretch', marginHorizontal: 24, paddingVertical: 4, paddingHorizontal: 12, gap: 4,
    borderLeftWidth: 2,
  },
  row: { gap: 1 },
  rowText: { fontSize: 12, lineHeight: lineHeightFor(12) },
  rawReason: { fontSize: 11, lineHeight: lineHeightFor(11) },
});
