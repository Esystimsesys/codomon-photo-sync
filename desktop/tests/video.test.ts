import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hlsSegments, hlsVariant, stampMp4Date, syncCodmonRequest, timelineVideoSource, videoSeconds, videoThumbnailPath } from '../src/main/connectors';
import type { Settings } from '../src/shared/types';

const CDN = 'https://streamingcdn.codmon.com/uuid/hls/';
const MASTER = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8?Policy=p\n#EXT-X-STREAM-INF:BANDWIDTH=2327440,RESOLUTION=1280x720\nhigh.m3u8?Policy=p\n`;
const MEDIA = `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nseg1.ts?Policy=p\n#EXTINF:6,\nseg2.ts?Policy=p\n#EXT-X-ENDLIST\n`;

test('the highest-bandwidth variant is chosen and only complete, unencrypted MPEG-TS playlists are accepted', () => {
  assert.equal(hlsVariant(MASTER, `${CDN}master.m3u8?Policy=p`), `${CDN}high.m3u8?Policy=p`);
  assert.equal(hlsVariant(MEDIA, `${CDN}high.m3u8`), `${CDN}high.m3u8`);
  assert.deepEqual(hlsSegments(MEDIA, `${CDN}high.m3u8`), [`${CDN}seg1.ts?Policy=p`, `${CDN}seg2.ts?Policy=p`]);
  assert.throws(() => hlsSegments(MEDIA.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF'), CDN), /暗号化/);
  assert.throws(() => hlsSegments(MEDIA.replace('#EXT-X-ENDLIST\n', ''), CDN), /終わっていません/);
  assert.throws(() => hlsSegments(MEDIA.replace('seg1.ts', 'https://evil.example/seg1.ts'), CDN), /コドモンのドメイン/);
});

test('a video is named by its original name and size, so a re-posted video keeps one identity', () => {
  const item = (id: string) => ({ attached_video_info: { uploaded_video: { video_id: id, file_name: 'IMG_0665.mov', file_size: '130077733', video_dist_url: `${CDN}x.m3u8?Policy=p`, video_dist_thumbnail_url: 'https://streamingcdn.codmon.com/uuid/thumbnails/x_thumb.0000024.jpg' } } });
  assert.deepEqual(timelineVideoSource(item('740198')), timelineVideoSource(item('749411')));
  assert.equal(timelineVideoSource(item('1'))?.filename, 'IMG_0665-130077733.mp4');
  assert.equal(timelineVideoSource({ attached_video_info: { uploaded_video: { video_dist_url: '', video_conversion_status: 'Unprocessed' } } }), null);
  // コドモンの共通画像（変換前の仮のサムネイル）は一覧の画像にしない。
  assert.equal(timelineVideoSource({ attached_video_info: { uploaded_video: { file_name: 'a.mp4', video_dist_url: `${CDN}x.m3u8`, video_dist_thumbnail_url: 'https://ps-api.codmon.com/manage/assets/img/ogp.png' } } })?.thumbnail, '');
});

const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, 'latin1'); return Buffer.concat([head, body]); };
const header = (version = 0) => { const b = Buffer.alloc(version ? 36 : 24); b[0] = version; return b; };
const movie = () => Buffer.concat([box('ftyp', Buffer.from('mp42')), box('moov', box('mvhd', header()), box('trak', box('tkhd', header(1)), box('mdia', box('mdhd', header())))), box('mdat', Buffer.alloc(32))]);
/** The creation times of mvhd, tkhd and mdhd as seconds since 1970. */
function times(buf: Buffer): number[] {
  const at = (type: string) => buf.indexOf(type, 0, 'latin1') + 4;
  const mvhd = at('mvhd'), tkhd = at('tkhd'), mdhd = at('mdhd');
  return [buf.readUInt32BE(mvhd + 4), Number(buf.readBigUInt64BE(tkhd + 4)), buf.readUInt32BE(mdhd + 4)].map(t => t - 2_082_844_800);
}

test('the post date is written into the movie, track and media headers in Japan time', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codomon-mp4-'));
  try {
    const file = path.join(dir, 'a.mp4'); await writeFile(file, movie());
    await stampMp4Date(file, { display_date: '2026-10-13', delivery_start_datetime: '2026-10-13 08:57:01' });
    const expected = Date.parse('2026-10-13T08:57:01+09:00') / 1000;
    assert.deepEqual(times(await readFile(file)), [expected, expected, expected]);
    assert.equal((await readFile(file)).length, movie().length);
    await writeFile(file, Buffer.from('not a movie at all'));
    await assert.rejects(stampMp4Date(file, { display_date: '2026-10-13' }), /動画の形式/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sync saves a converted video once as an MP4 photo entry, links it from the record and skips encrypted streams', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codomon-video-sync-'));
  const requested: string[] = [];
  let media = MEDIA;
  const uploaded = (videoId: string) => ({ video_id: videoId, file_name: 'IMG_0665.mov', file_size: '130077733', expiration_datetime: '2026-10-27 08:57:01', video_conversion_status: 'Complete',
    video_dist_url: `${CDN}6acd.m3u8?Policy=p&Signature=s`, video_dist_thumbnail_url: 'https://streamingcdn.codmon.com/uuid/thumbnails/6acd_thumb.0000024.jpg' });
  let timeline: unknown[] = [{ id: 189933055, timeline_kind: 'topics', display_date: '2026-10-13', delivery_start_datetime: '2026-10-13 08:57:01', title: '【期間延長】お手本', content: '練習してね', attached_video_info: { uploaded_video: uploaded('749411') } }];
  const fake = { get: async (raw: string) => { const u = new URL(raw); requested.push(u.pathname);
    const body = u.pathname.endsWith('6acd.m3u8') ? gzipSync(MASTER) : u.pathname.endsWith('high.m3u8') ? Buffer.from(media) : u.pathname.endsWith('.ts') ? Buffer.concat([Buffer.from([0x47]), Buffer.from(u.pathname)]) : u.pathname.endsWith('.jpg') ? Buffer.from([0xff, 0xd8, 0xff]) : Buffer.from('');
    return { dispose: async () => {}, status: () => 200, headers: () => ({}), body: async () => body,
      json: async () => u.pathname.endsWith('/services/') ? { data: { s: {} } } : u.pathname.endsWith('/timeline/') ? { data: timeline } : {} }; } } as any;
  const converted: string[] = [];
  const convertVideo = async (source: string, output: string) => { converted.push((await readFile(source, 'latin1'))); await writeFile(output, movie()); };
  const s = { ...({ album: '園', people: [] } as unknown as Settings), saveRoot: dir };
  try {
    const first = await syncCodmonRequest(s, fake, '2026-10-01', '2026-10-13', { convertVideo });
    assert.deepEqual(first.errors, []);
    const dest = path.join(dir, '2026-10-13', 'IMG_0665-130077733.mp4');
    assert.deepEqual(first.photos, [{ id: 'IMG_0665-130077733.mp4', filename: 'IMG_0665-130077733.mp4', path: dest, date: '2026-10-13', title: '【期間延長】お手本', postId: 's:topics:189933055', postedDate: '2026-10-13' }]);
    assert.deepEqual(converted, ['\x47/uuid/hls/seg1.ts\x47/uuid/hls/seg2.ts'], 'segments of the highest variant are joined in order');
    assert.equal(times(await readFile(dest))[0], Date.parse('2026-10-13T08:57:01+09:00') / 1000);
    assert.ok(existsSync(videoThumbnailPath(dir, 'IMG_0665-130077733.mp4')));
    assert.deepEqual((await readdir(path.join(dir, '2026-10-13'))).filter(f => f.startsWith('.')), [], 'no partial files are left');
    assert.equal(first.posts[0].videos?.[0].path, dest);
    assert.match(await readFile(first.posts[0].path, 'utf8'), /\[動画: IMG_0665\.mov（124MB・再生期限 2026-10-27 08:57:01）\]\(\.\.\/IMG_0665-130077733\.mp4\)/);

    // 期間延長で別の日に再掲された同じ動画は、取り直さずに最初の保存先を使う。
    timeline = [{ ...timeline[0] as object, id: 190000000, display_date: '2026-10-20', attached_video_info: { uploaded_video: uploaded('760000') } }];
    requested.length = 0;
    const again = await syncCodmonRequest(s, fake, '2026-10-01', '2026-10-31', { convertVideo });
    assert.deepEqual(again.errors, []); assert.equal(again.photos[0].path, dest);
    assert.equal(requested.filter(p => p.includes('/hls/')).length, 0); assert.equal(converted.length, 1);

    // 暗号化された配信は保存せず、記録だけ残す。
    await rm(dest); await rm(path.join(dir, '.video-sources'), { recursive: true });
    media = MEDIA.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF');
    const encrypted = await syncCodmonRequest(s, fake, '2026-10-01', '2026-10-31', { convertVideo });
    assert.deepEqual(encrypted.photos, []); assert.equal(encrypted.posts.length, 1); assert.equal(encrypted.posts[0].videos?.[0].path, undefined);
    assert.match(encrypted.errors[0], /動画: 動画が暗号化されているため保存しません/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('video length comes from the movie header; unreadable files give null', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'codomon-length-'));
  try {
    const mvhd = Buffer.alloc(24); mvhd.writeUInt32BE(600, 12); mvhd.writeUInt32BE(74_100, 16);
    const file = path.join(dir, 'a.mp4');
    await writeFile(file, Buffer.concat([box('ftyp', Buffer.from('mp42')), box('moov', box('mvhd', mvhd))]));
    assert.equal(await videoSeconds(file), 123.5);
    await writeFile(file, 'not a movie');
    assert.equal(await videoSeconds(file), null);
    assert.equal(await videoSeconds(path.join(dir, 'missing.mp4')), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
