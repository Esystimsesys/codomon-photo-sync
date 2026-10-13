import test from 'node:test';
import assert from 'node:assert/strict';
import { recordEntry, recordExcerpt } from '../src/renderer/records';

const post = (kind: string, body: string) => ({ id: 'p', date: '2025-04-03', kind, title: '', body, path: '', attachments: [], author: '先生' });

test('contact notes become fields, even with raw line breaks inside JSON strings', () => {
  const note = recordEntry(post('comments', '{"memo":"一行目\n二行目","meal":"主食　完食","tempratures":[{"temprature":"37.0","temprature_time":"14:20:00"}],"mood_morning":"良"}'));
  assert.deepEqual([note.kind, note.author, note.text], ['連絡帳', '先生', '一行目\n二行目']);
  assert.deepEqual(note.fields, [['機嫌', '朝 良'], ['体温', '14:20 37.0℃'], ['食事', '主食　完食']]);
});

test('bill amounts are shown in yen', () => {
  assert.deepEqual(recordEntry(post('bills', '延長保育料 3200')).items, ['延長保育料 3,200円']);
});

test('videos show their size and the playback deadline in Japan time', () => {
  const p = { ...post('topics', 'お手本'), videos: [{ name: 'IMG_0665.mov', size: 130077733, expires: '2026-10-20 12:26:03' }, { name: '動画', size: 0, expires: '' }] };
  assert.deepEqual(recordEntry(p, new Date('2026-10-20T03:26:02Z')).videos, [
    { name: 'IMG_0665.mov', size: '124MB', expires: '10月20日 12:26', expired: false, saved: false }, { name: '動画', size: '', expires: '', expired: false, saved: false }]);
  assert.equal(recordEntry(p, new Date('2026-10-20T03:27:00Z')).videos[0].expired, true);
});

test('attachments show their original name and type; the excerpt is one short line', () => {
  const p = { ...post('topics', '運動会のお知らせです。\n\n当日は8時半までに登園してください。'), attachments: ['/a/2026-10-01/添付/s_topics_9-0123456789ab-10月の園だより.pdf', '/a/添付/s_topics_9-0123456789ab-photo.JPG', '/a/添付/noprefix'] };
  const r = recordEntry(p);
  assert.deepEqual(r.files, [{ name: '10月の園だより.pdf', type: 'PDF' }, { name: 'photo.JPG', type: '画像' }, { name: 'noprefix', type: 'ファイル' }]);
  assert.equal(recordExcerpt(r), '運動会のお知らせです。 当日は8時半までに登園してください。');
  assert.equal(recordExcerpt(r, 5), '運動会のお…');
  assert.equal(recordExcerpt(recordEntry(post('comments', '{"meal":"完食"}'))), '食事 完食');
});
