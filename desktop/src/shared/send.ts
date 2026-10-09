import type { Photo, Settings } from './types';
type SendPhoto = Pick<Photo, 'date' | 'postedDate'>;
type SendSettings = Pick<Settings, 'miteneEnabled' | 'sendMode' | 'autoSendFrom'>;
export const autoSending = (s: Pick<Settings, 'miteneEnabled' | 'sendMode'>) => s.miteneEnabled && s.sendMode === 'automatic';
/**
 * 自動で送るのは、自動送信をオンにした日以降にコドモンに届いた写真だけ。届いた日が分からない古いデータは、園が付けた表示日で判定する。
 * 初めて使う人の過去の写真が、最初の同期でまとめてみてねに送られないようにする。それより前の写真は手動でだけ送る。
 */
export function beforeAutoSend(p: SendPhoto, s: SendSettings): boolean {
  const day = p.postedDate || p.date;
  return autoSending(s) && !(s.autoSendFrom && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= s.autoSendFrom);
}
