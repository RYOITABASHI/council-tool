import { StyleSheet, Text } from 'react-native';
import type { PacketEntry } from '../types';
import { formatTime, ui } from './styles';

export function AttestRow({ entry }: { entry: PacketEntry<'attest'> }) {
  const { header, body } = entry.packet;
  const result = body.result === 'confirmed' ? '確認済み' : '不一致';
  return (
    <Text style={[ui.muted, styles.center]}>
      {header.seat_id ?? 'システム'} の回答を議長が verbatim 照合：{result} · {formatTime(header.created_at)}
    </Text>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center', paddingVertical: 5 },
});
