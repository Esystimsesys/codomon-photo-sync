import test from 'node:test';
import assert from 'node:assert/strict';
import { recordEntries } from '../src/renderer/records';

const post = (kind: string, body: string) => ({ id: 'p', date: '2025-04-03', kind, title: '', body, path: '', attachments: [] });

test('legacy day files expand into readable entries without Markdown syntax', () => {
  const body = '# 2025-04-03 の記録\n\n## [連絡帳]\n\n- 投稿者: 先生\n\n{"memo":"一行目\n二行目","meal":"主食　完食","tempratures":[{"temprature":"37.0","temprature_time":"14:20:00"}],"mood_morning":"良"}\n\n## [活動記録] お散歩\n\n- 公開範囲: 全体 / 配信: 2025-04-03 13:00:00\n\n公園に行きました。\n\n### 写真 1枚\n- ![](a.jpeg)\n\n- 添付: [a.pdf](添付/1-a.pdf)\n';
  const [note, activity] = recordEntries(post('記録', body));
  assert.deepEqual([note.kind, note.author, note.text], ['連絡帳', '先生', '一行目\n二行目']);
  assert.deepEqual(note.fields, [['機嫌', '朝 良'], ['体温', '14:20 37.0℃'], ['食事', '主食　完食']]);
  assert.deepEqual([activity.kind, activity.title, activity.text, activity.attachments], ['活動記録', 'お散歩', '公園に行きました。', 1]);
});

test('bill amounts are shown in yen', () => {
  assert.deepEqual(recordEntries(post('bills', '延長保育料 3200')).map(r => r.items), [['延長保育料 3,200円']]);
});
