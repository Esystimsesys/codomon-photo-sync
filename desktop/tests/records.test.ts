import test from 'node:test';
import assert from 'node:assert/strict';
import { recordEntry } from '../src/renderer/records';

const post = (kind: string, body: string) => ({ id: 'p', date: '2025-04-03', kind, title: '', body, path: '', attachments: [], author: '先生' });

test('contact notes become fields, even with raw line breaks inside JSON strings', () => {
  const note = recordEntry(post('comments', '{"memo":"一行目\n二行目","meal":"主食　完食","tempratures":[{"temprature":"37.0","temprature_time":"14:20:00"}],"mood_morning":"良"}'));
  assert.deepEqual([note.kind, note.author, note.text], ['連絡帳', '先生', '一行目\n二行目']);
  assert.deepEqual(note.fields, [['機嫌', '朝 良'], ['体温', '14:20 37.0℃'], ['食事', '主食　完食']]);
});

test('bill amounts are shown in yen', () => {
  assert.deepEqual(recordEntry(post('bills', '延長保育料 3200')).items, ['延長保育料 3,200円']);
});
