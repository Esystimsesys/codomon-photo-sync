import { chromium, type APIResponse, type BrowserContext, type Page } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import piexif from 'piexifjs';
import type { ArchivePhoto, ArchivePost, ArchiveVideo, SyncResult, FaceResult, Person, Settings } from '../shared/types';
import { personAlbum } from './store';
import { isVideo } from '../shared/media';

export type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface ConnectorOptions {
  executablePath?: string;
  onProgress?: (message: string) => void;
  onSession?: (session: Session) => Promise<void> | void;
  /** Walk back from the newest month and stop after this many months in a row without records. */
  stopAfterEmptyMonths?: number;
  /** Months ending on or after this day are always fetched, even after a run of empty months. */
  fetchAllFrom?: string;
  /** Pause between timeline requests so コドモン is not queried in a burst. */
  requestIntervalMs?: number;
  /** Turns the joined MPEG-TS segments into an MP4. Defaults to macOS avconvert; tests replace it. */
  convertVideo?: (source: string, output: string) => Promise<void>;
}
type Item = Record<string, any>;
const API = 'https://ps-api.codmon.com/api/v2/parent';
const UPLOADER = 'https://mitene.us/web/uploader';
const exec = promisify(execFile);

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/) || value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
}
/** 保護者に届いた日。配信開始の日時、なければ投稿の日時。自動送信の対象かどうかの判定に使う。 */
export function postedDate(item: Item): string {
  return normalizeDate(item.delivery_start_datetime) || normalizeDate(item.insert_datetime) || '';
}
export function entryDate(item: Item): string {
  return normalizeDate(item.display_date) || normalizeDate(item.insert_datetime) || normalizeDate(item.open_datetime) || 'unknown-date';
}
export function monthlyIntervals(start: string, end: string): [string, string][] {
  if (normalizeDate(start) !== start || normalizeDate(end) !== end || start > end) throw new Error('取得期間が正しくありません');
  const out: [string, string][] = [];
  let cursor = start;
  while (cursor <= end) {
    const d = new Date(`${cursor}T12:00:00Z`);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
    const until = last < end ? last : end;
    out.push([cursor, until]);
    const next = new Date(`${until}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return out;
}
export function timelinePhotos(item: Item): Item[] {
  return Array.isArray(item.photos) ? item.photos.filter(p => p && typeof p === 'object' && typeof p.url === 'string' && p.url) : [];
}
/** お知らせに付いた動画。コドモンは1件に1本で、`attached_video_info.uploaded_video` に入る。 */
export function timelineVideos(item: Item): ArchiveVideo[] {
  const v = item.attached_video_info?.uploaded_video;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const size = Number(v.file_size);
  return [{ name: typeof v.file_name === 'string' && v.file_name.trim() ? v.file_name.trim() : '動画', size: Number.isFinite(size) && size > 0 ? size : 0,
    expires: typeof v.expiration_datetime === 'string' ? v.expiration_datetime : '' }];
}
export function videoLine(video: ArchiveVideo): string {
  const details = [video.size ? `${(video.size / 1024 / 1024).toFixed(0)}MB` : '', video.expires ? `再生期限 ${video.expires}` : ''].filter(Boolean).join('・');
  return `動画: ${video.name}${details ? `（${details}）` : ''}`;
}
export function safeFilename(value: string, maxBytes = 240): string {
  const name = value.replace(/[\\/\x00-\x1f:]/g, '_').replace(/^\.+$/, '_') || 'file';
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;
  const rawExtension = path.extname(name);
  const extension = Buffer.byteLength(rawExtension, 'utf8') <= 32 ? rawExtension : '';
  const suffix = `-${createHash('sha256').update(value).digest('hex').slice(0, 12)}${extension}`;
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  let prefix = '', bytes = 0;
  for (const character of name.slice(0, extension ? -extension.length : undefined)) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) break;
    prefix += character; bytes += size;
  }
  return prefix + suffix;
}
export function photoFilename(url: string): string {
  const raw = new URL(url).pathname.split('/').pop() || 'photo.jpeg';
  if (/[\\/\x00-\x1f:]/.test(raw) || raw === '.' || raw === '..') throw new Error('画像のファイル名を安全に保存できません');
  return safeFilename(raw);
}
export function codmonUrl(value: string): string {
  const u = new URL(value, 'https://ps-api.codmon.com');
  if (u.protocol !== 'https:' || !(u.hostname === 'codmon.com' || u.hostname.endsWith('.codmon.com')) || u.username || u.password) throw new Error('取得先のURLがコドモンのドメインではありません');
  return u.href;
}
export function toText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, k: string) => ({ amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ' }[k]!))
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, k: string) => { const n = k[0].toLowerCase() === 'x' ? parseInt(k.slice(1),16) : Number(k); return n <= 0x10ffff ? String.fromCodePoint(n) : ''; }).trim();
}
export function recordBody(item: Item): string {
  const rows = Array.isArray(item.data) ? item.data : [];
  return [toText(item.overview || item.content), ...rows.filter(r => r && typeof r === 'object').map(r => `${r.name ?? r.title ?? r.item_name ?? r.billing_item_name ?? ''} ${r.amount ?? r.price ?? r.total ?? ''}`.trim()).filter(Boolean)].filter(Boolean).join('\n');
}
export function stampExif(data: Buffer, item: Item): Buffer {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('JPEG画像ではありません');
  const day = entryDate(item);
  if (day === 'unknown-date') throw new Error('写真の撮影日を確認できません');
  const time = String(item.delivery_start_datetime || item.insert_datetime || '').match(/\d{2}:\d{2}:\d{2}/)?.[0] || '12:00:00';
  const when = `${day.replaceAll('-', ':')} ${time}`;
  const exif = { '0th': { [piexif.ImageIFD.DateTime]: when }, Exif: { [piexif.ExifIFD.DateTimeOriginal]: when, [piexif.ExifIFD.DateTimeDigitized]: when } };
  return Buffer.from(piexif.insert(piexif.dump(exif), data.toString('binary')), 'binary');
}
export interface VideoSource { url: string; filename: string; thumbnail: string; }
/**
 * 変換の済んだ動画の取得元。ファイル名は元の名前とサイズで決める。園が期間を延長すると同じ動画が別のIDで再掲されるため、
 * 取得元のIDではなく中身で同じ動画とみなし、二重に保存・送信しない。
 */
export function timelineVideoSource(item: Item): VideoSource | null {
  const v = item.attached_video_info?.uploaded_video;
  if (!v || typeof v !== 'object' || typeof v.video_dist_url !== 'string' || !v.video_dist_url) return null;
  const name = typeof v.file_name === 'string' && v.file_name.trim() ? v.file_name.trim() : '';
  const stem = path.parse(name.replace(/[\\/]/g, '_')).name || `video-${String(v.video_id ?? 'unknown')}`;
  const tag = /^\d+$/.test(String(v.file_size ?? '')) ? String(v.file_size) : String(v.video_id ?? '');
  const thumbnail = typeof v.video_dist_thumbnail_url === 'string' && /\.jpe?g$/i.test(new URL(v.video_dist_thumbnail_url, 'https://ps-api.codmon.com').pathname) ? codmonUrl(v.video_dist_thumbnail_url) : '';
  return { url: codmonUrl(v.video_dist_url), filename: safeFilename(`${stem}${tag ? `-${tag}` : ''}.mp4`), thumbnail };
}
/** 動画の一覧用の画像。保存先の隠しフォルダに、動画のファイル名から決まる名前で置く。 */
export function videoThumbnailPath(saveRoot: string, filename: string): string {
  return path.join(saveRoot, '.video-thumbnails', `${createHash('sha256').update(filename).digest('hex').slice(0, 24)}.jpg`);
}
/** A master playlist names the variants; take the highest bandwidth. A media playlist is returned as is. */
export function hlsVariant(playlist: string, base: string): string {
  const lines = playlist.split(/\r?\n/).map(l => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('動画の配信形式が変わっています');
  let best: { url: string; bandwidth: number } | null = null;
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const uri = lines.slice(i + 1).find(l => l && !l.startsWith('#'));
    const bandwidth = Number(line.match(/[:,]BANDWIDTH=(\d+)/)?.[1] ?? 0);
    if (uri && (!best || bandwidth > best.bandwidth)) best = { url: codmonUrl(new URL(uri, base).href), bandwidth };
  });
  return (best as { url: string } | null)?.url ?? base;
}
/** Only complete, unencrypted MPEG-TS playlists are saved. Encrypted streams are left alone rather than decrypted. */
export function hlsSegments(playlist: string, base: string): string[] {
  const lines = playlist.split(/\r?\n/).map(l => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('動画の配信形式が変わっています');
  if (lines.some(l => l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l)) || lines.some(l => l.startsWith('#EXT-X-SESSION-KEY'))) throw new Error('動画が暗号化されているため保存しません');
  if (lines.some(l => l.startsWith('#EXT-X-MAP'))) throw new Error('この動画の配信形式には対応していません');
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('動画の配信がまだ終わっていません');
  const segments = lines.filter(l => l && !l.startsWith('#')).map(l => codmonUrl(new URL(l, base).href));
  if (!segments.length) throw new Error('動画の配信形式が変わっています');
  return segments;
}
const MAC_EPOCH_OFFSET = 2_082_844_800;
/** The top-level moov box of an MP4 file, read whole (it holds only headers and sample tables). */
async function readMoov(f: fs.FileHandle): Promise<{ offset: number; header: number; box: Buffer }> {
  const { size } = await f.stat();
  for (let offset = 0; offset + 8 <= size;) {
    const head = Buffer.alloc(16);
    await f.read(head, 0, 16, offset);
    let length = head.readUInt32BE(0), header = 8;
    if (length === 1) { length = Number(head.readBigUInt64BE(8)); header = 16; } else if (length === 0) length = size - offset;
    if (length < header || offset + length > size) break;
    if (head.toString('latin1', 4, 8) === 'moov') {
      if (length > 64 * 1024 * 1024) break;
      const box = Buffer.alloc(length);
      await f.read(box, 0, length, offset);
      return { offset, header, box };
    }
    offset += length;
  }
  throw new Error('動画の形式を確認できません');
}
/** Write the post's date into the movie, track and media headers, as the photos get it in EXIF. The file size is unchanged. */
export async function stampMp4Date(filename: string, item: Item): Promise<void> {
  const day = entryDate(item);
  if (day === 'unknown-date') return;
  const time = String(item.delivery_start_datetime || item.insert_datetime || '').match(/\d{2}:\d{2}:\d{2}/)?.[0] || '12:00:00';
  const seconds = Math.floor(Date.parse(`${day}T${time}+09:00`) / 1000) + MAC_EPOCH_OFFSET;
  const f = await fs.open(filename, 'r+');
  try {
    const { offset, header, box } = await readMoov(f);
    stampBoxes(box, header, box.length, seconds);
    await f.write(box, 0, box.length, offset);
  } finally { await f.close(); }
}
/** Length in seconds from the movie header, or null when the file cannot be read as an MP4. */
export async function videoSeconds(filename: string): Promise<number | null> {
  let f: fs.FileHandle | undefined;
  try {
    f = await fs.open(filename, 'r');
    const { header, box } = await readMoov(f);
    for (let o = header; o + 8 <= box.length;) {
      const size = box.readUInt32BE(o);
      if (size < 8) return null;
      if (box.toString('latin1', o + 4, o + 8) === 'mvhd') {
        const v = box[o + 8];
        const scale = box.readUInt32BE(o + (v === 1 ? 28 : 20)), duration = v === 1 ? Number(box.readBigUInt64BE(o + 32)) : box.readUInt32BE(o + 24);
        return scale ? duration / scale : null;
      }
      o += size;
    }
    return null;
  } catch { return null; }
  finally { await f?.close(); }
}
function stampBoxes(buf: Buffer, start: number, end: number, seconds: number): void {
  for (let o = start; o + 8 <= end;) {
    let size = buf.readUInt32BE(o), header = 8;
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); header = 16; } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    if (type === 'trak' || type === 'mdia') stampBoxes(buf, o + header, o + size, seconds);
    else if ((type === 'mvhd' || type === 'tkhd' || type === 'mdhd') && size >= header + 20) {
      // creation_time and modification_time follow version and flags.
      if (buf[o + header] === 1) { buf.writeBigUInt64BE(BigInt(seconds), o + header + 4); buf.writeBigUInt64BE(BigInt(seconds), o + header + 12); }
      else { buf.writeUInt32BE(seconds, o + header + 4); buf.writeUInt32BE(seconds, o + header + 8); }
    }
    o += size;
  }
}
/** Repackage without re-encoding. avconvert ships with macOS, so nothing is bundled. */
async function avconvert(source: string, output: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('動画の保存はMacのみ対応しています');
  try { await exec('/usr/bin/avconvert', ['--source', source, '--preset', 'PresetPassthrough', '--output', output, '--replace'], { timeout: 15 * 60_000 }); }
  catch { throw new Error('動画をMP4に変換できませんでした'); }
}
/** Fetch every segment into one MPEG-TS file next to the destination, convert it, date it, then move it into place. */
export async function downloadVideo(request: Pick<BrowserContext['request'], 'get'>, source: VideoSource, dest: string, item: Item, options: ConnectorOptions = {}): Promise<void> {
  const text = async (url: string) => consumeResponse(await request.get(url, { timeout: 60_000 }), async r => {
    if (r.status() !== 200) throw new Error(`動画を取得できません（HTTP ${r.status()}）`);
    const body = await r.body();
    return (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString('utf8');
  });
  const master = await text(source.url), variant = hlsVariant(master, source.url);
  const segments = hlsSegments(variant === source.url ? master : await text(variant), variant);
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(dest), `.${randomUUID()}`), ts = `${temp}.ts`, mp4 = `${temp}.mp4`;
  try {
    const f = await fs.open(ts, 'wx', 0o600);
    try {
      for (const [i, url] of segments.entries()) {
        options.onProgress?.(`動画を保存しています（${source.filename}・${i + 1}/${segments.length}）`);
        const bytes = await consumeResponse(await request.get(url, { timeout: 120_000 }), async r => {
          if (r.status() !== 200) throw new Error(`動画を取得できません（HTTP ${r.status()}）`);
          return r.body();
        });
        if (bytes[0] !== 0x47) throw new Error('動画の配信形式が変わっています');
        await f.write(bytes);
      }
      await f.sync();
    } finally { await f.close(); }
    await (options.convertVideo ?? avconvert)(ts, mp4);
    if (!(await fs.stat(mp4)).size) throw new Error('動画をMP4に変換できませんでした');
    await stampMp4Date(mp4, item);
    await fs.rename(mp4, dest);
  } finally { await Promise.all([fs.rm(ts, { force: true }), fs.rm(mp4, { force: true })]); }
}
export async function atomicWrite(filename: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(filename), `.${randomUUID()}.part`);
  try {
    const f = await fs.open(temp, 'wx', 0o600);
    try { await f.writeFile(data); await f.sync(); } finally { await f.close(); }
    await fs.rename(temp, filename);
  } finally { await fs.rm(temp, { force: true }); }
}
async function exists(filename: string): Promise<boolean> { try { await fs.access(filename); return true; } catch { return false; } }
// Playwright retains response bodies until disposed, even after body()/json() returns.
async function consumeResponse<T>(response: APIResponse, read: (response: APIResponse) => T | Promise<T>): Promise<T> {
  try { return await read(response); }
  finally { await response.dispose(); }
}
async function contextFor(session: Session | undefined, options: ConnectorOptions, headless = true) {
  const browser = await chromium.launch({ headless, executablePath: options.executablePath });
  try { return { browser, context: await browser.newContext({ storageState: session, locale: 'ja-JP' }) }; }
  catch (e) { await browser.close(); throw e; }
}
export async function manualLogin(provider: 'codmon' | 'mitene', options: ConnectorOptions = {}): Promise<Session> {
  const { browser, context } = await contextFor(undefined, options, false);
  try {
    const page = await context.newPage();
    await page.goto(provider === 'codmon' ? 'https://parents.codmon.com/' : UPLOADER, { waitUntil: 'domcontentloaded' });
    options.onProgress?.('開いたブラウザでログインしてください。認証コードもご自身で入力してください。');
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (!browser.isConnected() || page.isClosed()) throw new Error('ログイン画面が閉じられました');
      let authenticated = false;
      if (provider === 'codmon') {
        authenticated = await consumeResponse(await context.request.get(`${API}/my/`, { timeout: 15_000 }), response => response.status() === 200);
      } else {
        const u = new URL(page.url());
        authenticated = u.hostname === 'mitene.us' && u.pathname.startsWith('/web/uploader') && await page.locator('input[type=file]').count() === 1;
      }
      if (authenticated) { const session = await context.storageState(); await options.onSession?.(session); return session; }
      await page.waitForTimeout(2500);
    }
    throw new Error('ログインを確認できないまま時間切れになりました。もう一度ログインしてください');
  } finally { await browser.close(); }
}
export async function fetchTimeline(request: Pick<BrowserContext['request'], 'get'>, serviceId: string, start: string, end: string): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; page <= 50; page++) {
    const query = new URLSearchParams({ listpage:String(page), 'search_type[]':'new_all', start_date:start, end_date:end, service_id:serviceId, current_flag:'0', use_image_edge:'true', bookmark_only:'false', __env__:'myapp' });
    const data = await consumeResponse(await request.get(`${API}/timeline/?${query}`), async r => {
      if (r.status() !== 200) throw new Error(`記録の取得に失敗しました（HTTP ${r.status()}）`);
      return r.json();
    });
    if (!Array.isArray(data.data)) throw new Error('記録の応答形式が変わっています');
    items.push(...data.data);
    if (!data.next_page) return items;
    if (!data.data.length) throw new Error('記録の取得が途中で進まなくなりました');
  }
  throw new Error('記録が多すぎて一度に取得できません。期間を短くして取り込んでください');
}
export async function syncCodmon(settings: Settings, session: Session, startDate: string, endDate: string, options: ConnectorOptions = {}): Promise<SyncResult> {
  monthlyIntervals(startDate, endDate);
  const { browser, context } = await contextFor(session, options);
  try {
    const result = await syncCodmonRequest(settings, context.request, startDate, endDate, options);
    await options.onSession?.(await context.storageState());
    return result;
  } finally { await browser.close(); }
}
export async function syncCodmonRequest(settings: Settings, request: BrowserContext['request'], startDate: string, endDate: string, options: ConnectorOptions = {}): Promise<SyncResult> {
  const ranges = monthlyIntervals(startDate, endDate);
  const result: SyncResult = { photos: [], posts: [], errors: [] };
    await consumeResponse(await request.get(`${API}/my/`), r => {
      if (r.status() !== 200) throw new Error('コドモンに再ログインしてください');
    });
    const services = await consumeResponse(await request.get(`${API}/services/?__env__=myapp&use_image_edge=true`), async r => {
      if (r.status() !== 200) throw new Error('コドモンの施設情報を取得できません');
      return (await r.json()).data;
    });
    if (!services || typeof services !== 'object' || Array.isArray(services) || !Object.keys(services).length) throw new Error('利用できる施設が見つかりません');
    const children = await childNames(request);
    const seen = new Set<string>();
    const photoSources = new Map<string, string>();
    const stopAfter = options.stopAfterEmptyMonths, interval = options.requestIntervalMs ?? 500;
    const ordered = stopAfter ? [...ranges].reverse() : ranges;
    let requested = false;
    for (const serviceId of Object.keys(services)) { let empty = 0; for (const [start, end] of ordered) {
      // Records begin at enrollment, so a year without any means the history before it is empty too.
      if (stopAfter && empty >= stopAfter && (!options.fetchAllFrom || end < options.fetchAllFrom)) break;
      if (requested && interval) await new Promise(resolve => setTimeout(resolve, interval));
      requested = true;
      options.onProgress?.(`${start} 〜 ${end} の記録を取得しています`);
      let items: Item[];
      try { items = await fetchTimeline(request, serviceId, start, end); }
      catch (e) { result.errors.push(`${start} 〜 ${end}: ${errorText(e)}`); continue; }
      empty = items.length ? 0 : empty + 1;
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { result.errors.push(`${start}: 記録の形式が正しくありません`); continue; }
        const id = `${serviceId}:${item.timeline_kind || 'unknown'}:${item.id ?? createHash('sha256').update(JSON.stringify(item)).digest('hex')}`;
        if (seen.has(id)) continue; seen.add(id);
        const date = entryDate(item), title = toText(item.title), kind = String(item.timeline_kind || 'unknown');
        const author = toText(item.insert_administrator_name);
        const names = [...new Set((Array.isArray(item.array_member_id) ? item.array_member_id : [item.member_id]).map(id => children.get(String(id))).filter((n): n is string => !!n))];
        const dir = path.join(settings.saveRoot, date);
        const stem = `${safeFilename(id, 200)}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
        const attachments: string[] = [];
        const photoPaths = new Set<string>();
        let savedVideo = '';
        for (const photo of timelinePhotos(item)) {
          try {
            const url = codmonUrl(photo.url), filename = photoFilename(url);
            const canonical = new URL(url).pathname;
            const sourceFile = path.join(settings.saveRoot, '.photo-sources', `${createHash('sha256').update(filename).digest('hex')}.json`);
            if (!photoSources.has(filename) && await exists(sourceFile)) {
              const saved = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
              if (typeof saved.pathname !== 'string') throw new Error('写真の取得元記録を確認できません');
              photoSources.set(filename, saved.pathname);
            }
            const previous = photoSources.get(filename);
            const collision = previous !== undefined && previous !== canonical;
            const dest = collision ? path.join(dir, '重複名の確認', safeFilename(`${createHash('sha256').update(canonical).digest('hex').slice(0,12)}-${filename}`)) : path.join(dir, filename);
            if (!await exists(dest)) {
              const bytes = await consumeResponse(await request.get(url), async r => {
                if (r.status() !== 200) throw new Error(`HTTP ${r.status()}`);
                return r.body();
              });
              if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG画像ではありません');
              await atomicWrite(dest, date === 'unknown-date' ? bytes : stampExif(bytes, item));
            }
            if (collision) { result.errors.push(`${date}: 同じファイル名の異なる写真を別フォルダに保存しました（${filename}）。確認が必要です`); continue; }
            if (previous === undefined) await atomicWrite(sourceFile, JSON.stringify({ filename, pathname: canonical }));
            photoSources.set(filename, canonical);
            photoPaths.add(dest);
            if (date === 'unknown-date') result.errors.push('日付が分からない写真を保存しました。この写真の「写真」アプリへの取り込みは保留しています');
            if (!result.photos.some(p => p.id === filename)) result.photos.push({ id: filename, filename, path: dest, date, title, postId: id, postedDate: postedDate(item) });
          } catch (e) { result.errors.push(`${date} 写真: ${errorText(e)}`); }
        }
        try {
          const video = timelineVideoSource(item);
          if (video) {
            // Re-posted videos (extended viewing periods) arrive on another day; keep the first saved copy.
            const sourceFile = path.join(settings.saveRoot, '.video-sources', `${createHash('sha256').update(video.filename).digest('hex')}.json`);
            const saved = await exists(sourceFile) ? JSON.parse(await fs.readFile(sourceFile, 'utf8')) : null;
            const dest = typeof saved?.path === 'string' && await exists(saved.path) ? saved.path as string : path.join(dir, video.filename);
            if (!await exists(dest)) await downloadVideo(request, video, dest, item, options);
            if (saved?.path !== dest) await atomicWrite(sourceFile, JSON.stringify({ filename: video.filename, path: dest }));
            const thumbnail = videoThumbnailPath(settings.saveRoot, video.filename);
            if (video.thumbnail && !await exists(thumbnail)) {
              // The list image is a convenience; a missing one never fails the video.
              try {
                const bytes = await consumeResponse(await request.get(video.thumbnail), async r => r.status() === 200 ? r.body() : null);
                if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) await atomicWrite(thumbnail, bytes);
              } catch { /* Shown with a placeholder. */ }
            }
            savedVideo = dest;
            if (date === 'unknown-date') result.errors.push('日付が分からない動画を保存しました。この動画の「写真」アプリへの取り込みは保留しています');
            if (!result.photos.some(p => p.id === video.filename)) result.photos.push({ id: video.filename, filename: video.filename, path: dest, date, title, postId: id, postedDate: postedDate(item) });
          }
        } catch (e) { result.errors.push(`${date} 動画: ${errorText(e)}`); }
        if (typeof item.file_url === 'string' && item.file_url) {
          try {
            const url = codmonUrl(item.file_url), dest = path.join(dir, '添付', safeFilename(`${stem}-${decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file')}`));
            if (!await exists(dest)) {
              const bytes = await consumeResponse(await request.get(url), async r => {
                if (r.status() !== 200 || /text\/html/i.test(r.headers()['content-type'] || '')) throw new Error('添付を取得できません');
                return r.body();
              });
              await atomicWrite(dest, bytes);
            }
            attachments.push(dest);
          } catch (e) { result.errors.push(`${date} 添付: ${errorText(e)}`); }
        }
        const body = recordBody(item), videos = timelineVideos(item), markdown = path.join(dir, '記録', `${stem}.md`);
        try {
          // Per-post files preserve earlier services, months and records on partial retrieval failures.
          await atomicWrite(path.join(dir, '記録', `${stem}.json`), JSON.stringify(item, null, 2));
          const link = (dest: string) => path.relative(path.dirname(markdown), dest).split(path.sep).map(encodeURIComponent).join('/');
          const photoLinks = [...photoPaths].map(p => `![写真](${link(p)})`);
          const attachmentLinks = attachments.map(p => `[添付ファイル](${link(p)})`);
          await atomicWrite(markdown, `# ${date} ${title}\n\n${kind}${author ? `\n\n投稿者: ${author}` : ''}${names.length ? `\n\n対象: ${names.join('・')}` : ''}\n\n${body}\n\n${[...photoLinks, ...attachmentLinks, ...videos.map(v => savedVideo ? `[${videoLine(v)}](${link(savedVideo)})` : videoLine(v))].join('\n\n')}\n`);
          result.posts.push({ id, date, kind, title, body, path: markdown, attachments, ...(author ? { author } : {}), ...(names.length ? { children: names } : {}), ...(videos.length ? { videos: videos.map(v => savedVideo ? { ...v, path: savedVideo } : v) } : {}) });
        } catch (e) { result.errors.push(`${date} 記録保存: ${errorText(e)}`); }
      }
    } }
    return result;
}
/** member_id → the child's name. Names only label records, so a failure here never stops archiving. */
export async function childNames(request: Pick<BrowserContext['request'], 'get'>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const data = await consumeResponse(await request.get(`${API}/children/?__env__=myapp`), async r => r.status() === 200 ? (await r.json()).data : null);
    for (const child of Array.isArray(data) ? data : []) {
      const name = [child?.nickname, child?.name].find(n => typeof n === 'string' && n.trim())?.trim();
      for (const relation of Array.isArray(child?.child_member_relations) ? child.child_member_relations : [])
        if (name && relation?.member_id != null) names.set(String(relation.member_id), name);
    }
  } catch { /* Keep archiving without labels. */ }
  return names;
}
function errorText(e: unknown): string { return e instanceof Error ? e.message : '処理に失敗しました'; }

export function appleScriptString(text: string): string { return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n')}"`; }
// Fetch all names in one Apple Event. Iterating media items one by one sends an event per photo, and Photos
// intermittently drops that connection midway (-609). -600/-609 also occur while Photos is launching or quitting.
const PHOTOS_DISCONNECTED = /\((-600|-609)\)/;
async function albumFilenames(album: string): Promise<Set<string>> {
  const name = appleScriptString(album);
  const script = `with timeout of 1800 seconds\ntell application "Photos"\nif not (exists album ${name}) then return ""\nset names to filename of every media item of album ${name}\nend tell\nend timeout\nset AppleScript's text item delimiters to linefeed\nreturn names as text`;
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await exec('/usr/bin/osascript', ['-e', script], { timeout: 1_810_000, maxBuffer: 20 * 1024 * 1024 });
      return new Set(stdout.split('\n').filter(Boolean));
    } catch (e) {
      const disconnected = PHOTOS_DISCONNECTED.test(String((e as { stderr?: unknown }).stderr ?? (e as Error).message));
      if (disconnected && attempt < 3) { await new Promise(resolve => setTimeout(resolve, attempt * 5_000)); continue; }
      throw new Error(disconnected ? 'Macの「写真」アプリとの接続が切れたため、アルバムの写真を確認できませんでした。次の自動実行で再試行します' : 'Macの「写真」アプリのアルバムを読み取れません。Macの「写真」アプリとオートメーション権限を確認してください');
    }
  }
}
export async function importIntoPhotos(settings: Settings, photos: ArchivePhoto[]): Promise<{ imported: string[]; errors: Record<string, string> }> {
  if (process.platform !== 'darwin') throw new Error('Macの「写真」アプリへの取り込みはMacのみ対応しています');
  const imported: string[] = [], errors: Record<string, string> = {};
  const have = await albumFilenames(settings.album);
  const todo = photos.filter(p => { if (p.date === 'unknown-date') { errors[p.id] = '日付が分からないため、取り込みを保留しています'; return false; } if (have.has(p.filename)) { imported.push(p.id); return false; } return true; });
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    try {
      await exec('/usr/bin/osascript', ['-e', `on run argv\nset fileList to {}\nrepeat with p in argv\nset end of fileList to (POSIX file (contents of p)) as alias\nend repeat\nwith timeout of 1800 seconds\ntell application "Photos"\nif not (exists album ${appleScriptString(settings.album)}) then make new album named ${appleScriptString(settings.album)}\nimport fileList into album ${appleScriptString(settings.album)} skip check duplicates false\nend tell\nend timeout\nend run`, ...chunk.map(p => p.path)], { timeout: 1_810_000 });
      const after = await albumFilenames(settings.album);
      for (const p of chunk) if (after.has(p.filename)) imported.push(p.id); else errors[p.id] = '取り込めたか確認できません。同じ写真がすでに「写真」アプリにある可能性があります';
    } catch { for (const p of chunk) errors[p.id] = 'Macの「写真」アプリへの取り込みに失敗しました。オートメーション権限を確認してください'; }
  }
  return { imported, errors };
}
export function judgeFace(px: number, ratio: number, people: number, s: Pick<Settings,'faceMinPx'|'faceMinRatio'|'faceMainRatio'|'faceMaxPeople'>): string {
  if (px <= 0) return '顔が検出されていません（胴体のみ）';
  if (px >= s.faceMinPx && ratio >= s.faceMinRatio) return '';
  if (ratio >= s.faceMainRatio && (s.faceMaxPeople <= 0 || people <= s.faceMaxPeople)) return '';
  return px < s.faceMinPx ? `顔が小さめです（${px.toFixed(0)}px・${people}人）` : `ほかの人が大きく写っています（比率 ${ratio.toFixed(2)}）`;
}
function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
export function readFaceResults(db: DatabaseSync, settings: Settings): FaceResult[] {
  if (!settings.people.length) return [];
  const pk = db.prepare('SELECT Z_PK FROM ZGENERICALBUM WHERE ZTITLE = ? AND ZTRASHEDSTATE = 0 ORDER BY ZCACHEDCOUNT DESC LIMIT 1').get(settings.album)?.Z_PK;
  if (!pk) return [];
  let join: { table: string; album: string; asset: string } | undefined;
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Z_[0-9]*ASSETS' ORDER BY name").all()) {
    const table = String(row.name);
    const cols = db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(c => String(c.name));
    const album = cols.find(c => c.endsWith('ALBUMS')), asset = cols.find(c => c.endsWith('ASSETS') && !c.startsWith('Z_FOK_'));
    if (album && asset) { join = { table, album, asset }; break; }
  }
  if (!join) throw new Error('この写真ライブラリの形式には対応していません。写真は手動で選択してください');
  const rows = db.prepare(`SELECT f.ZASSETFORFACE asset, aa.ZORIGINALFILENAME name, p.ZFULLNAME person, f.ZSIZE size, f.ZSOURCEWIDTH width FROM ZDETECTEDFACE f JOIN ${identifier(join.table)} a ON a.${identifier(join.asset)}=f.ZASSETFORFACE JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.ZASSET=f.ZASSETFORFACE LEFT JOIN ZPERSON p ON p.Z_PK=f.ZPERSONFORFACE WHERE a.${identifier(join.album)}=?`).all(pk);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const key = String(r.asset); groups.set(key, [...(groups.get(key) || []), r]); }
  const out: FaceResult[] = [];
  for (const dets of groups.values()) for (const { name: person } of settings.people) {
    // Siblings in one photo are judged separately; each one's face is compared with the largest face in it.
    const mine = dets.filter(r => r.person === person && r.name);
    if (!mine.length) continue;
    const best = mine.reduce((a, b) => Number(a.size) >= Number(b.size) ? a : b);
    const largest = Math.max(...dets.map(r => Number(r.size) || 0));
    const px = Number(best.size) * Number(best.width), ratio = largest > 0 ? Number(best.size) / largest : 0;
    const reason = judgeFace(px, ratio, dets.length, settings);
    out.push({ filename: String(best.name), person, selected: !reason, reason });
  }
  return out;
}
export async function analyzePhotos(settings: Settings): Promise<FaceResult[]> {
  if (process.platform !== 'darwin') throw new Error('Macの「写真」アプリの顔認識はMacのみ対応しています');
  const filename = settings.photosLibrary.endsWith('.sqlite') ? settings.photosLibrary : path.join(settings.photosLibrary, 'database', 'Photos.sqlite');
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(filename, { readOnly: true }); db.exec('PRAGMA busy_timeout=30000'); return readFaceResults(db, settings); }
  catch { throw new Error('写真ライブラリを読めません。Macの「写真」アプリを開き、ライブラリの場所とフルディスクアクセス権限を確認してください'); }
  finally { db?.close(); }
}
export function confirmedUploadCount(text: string): number | null {
  const m = text.match(/(?:^|\D)(\d+)\s*点のアップロードが完了しました/);
  return m ? Number(m[1]) : null;
}
export interface UploadCallbacks {
  beforeSend: (ids: string[]) => Promise<void> | void;
  onSent: (ids: string[]) => Promise<void> | void;
}
export async function uploadMitene(settings: Settings, session: Session, photos: ArchivePhoto[], callbacks: UploadCallbacks, options: ConnectorOptions = {}): Promise<void> {
  if (!photos.length) return;
  const { browser, context } = await contextFor(session, options);
  try {
    await uploadMitenePage(await context.newPage(), settings, photos, callbacks, options);
    await options.onSession?.(await context.storageState());
  } finally { await browser.close(); }
}
export async function uploadMitenePage(page: Page, settings: Settings, photos: ArchivePhoto[], callbacks: UploadCallbacks, options: ConnectorOptions = {}): Promise<void> {
    for (let i = 0; i < photos.length; i += 20) {
      const chunk = photos.slice(i, i + 20);
      await page.goto(UPLOADER, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (/\/web\/(login|otp)/.test(page.url())) throw new Error('みてねに再ログインしてください');
      const input = page.locator('input[type=file]');
      await input.waitFor({ state: 'attached', timeout: 30_000 });
      if (await input.count() !== 1) throw new Error('みてねの画面が変わったため、送信できません');
      if (confirmedUploadCount(await page.innerText('body')) !== null) throw new Error('前回の完了表示が残っています。送信を中止しました');
      await input.setInputFiles(chunk.map(p => p.path));
      const button = page.getByRole('button', { name: settings.miteneScope, exact: true });
      await button.waitFor({ state: 'visible', timeout: 30_000 });
      if (await button.count() !== 1) throw new Error('公開範囲のボタンを見つけられないため、送信を中止しました');
      await callbacks.beforeSend(chunk.map(p => p.id));
      // From this point an exception is ambiguous, including a click timeout. Never retry automatically.
      try {
        await button.click();
        await page.waitForFunction((count: number) => {
          const match = document.body.innerText.match(/(?:^|\D)(\d+)\s*点のアップロードが完了しました/);
          return match !== null && Number(match[1]) === count;
        }, chunk.length, { timeout: 180_000 + chunk.filter(p => isVideo(p.filename)).length * 120_000 });
        await callbacks.onSent(chunk.map(p => p.id));
      } catch { throw new Error('送信できたか確認できませんでした。みてねで届いているかを確かめて、写真画面で結果を選んでください'); }
      options.onProgress?.(`${Math.min(i + 20, photos.length)} / ${photos.length} 枚を送信しました`);
    }
}

/** Rebuild only album references. Original media assets are never deleted. */
export interface AlbumAdapter {
  run(body: string): Promise<{ stdout: string }>;
  albumFiles(album: string): Promise<Set<string>>;
}
export async function updatePersonAlbum(settings: Settings, person: Person, selected: ArchivePhoto[]): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Macの「写真」アプリのアルバム更新はMacのみ対応しています');
  await updatePersonAlbumWith(settings, person, selected, {
    run: async body => exec('/usr/bin/osascript', ['-e', `with timeout of 900 seconds\ntell application "Photos"\n${body}\nend tell\nend timeout`], { timeout: 910_000 }),
    albumFiles: albumFilenames,
  });
}
export async function updatePersonAlbumWith(settings: Pick<Settings, 'album'>, person: Person, selected: ArchivePhoto[], adapter: AlbumAdapter): Promise<void> {
  const { run, albumFiles } = adapter;
  const target = personAlbum(settings.album, person);
  if (target === settings.album) throw new Error('子どものアルバムには、取り込み先のアルバムと違う名前を付けてください');
  const { stdout: counts } = await run(`return ((count of (every album whose name is ${appleScriptString(settings.album)})) as text) & "," & ((count of (every album whose name is ${appleScriptString(target)})) as text)`);
  const [sourceCount, targetCount] = counts.trim().split(',').map(Number);
  if (sourceCount !== 1 || targetCount > 1 || !Number.isFinite(targetCount)) throw new Error('同じ名前のアルバムが複数あるか、取り込み先のアルバムがありません。「写真」アプリのアルバム名を確認してください');
  const wanted = new Set(selected.map(p => p.filename));
  const before = await albumFiles(target);
  if (wanted.size === before.size && [...wanted].every(name => before.has(name))) return;
  const source = await albumFiles(settings.album);
  if ([...wanted].some(name => !source.has(name))) throw new Error('子どものアルバムに入れる写真が、取り込み先のアルバムにありません。今のアルバムはそのまま残しました');
  const token = randomUUID().slice(0, 8), staging = `${target}（更新中 ${token}）`, backup = `${target}（更新前 ${token}）`;

  await run(`make new album named ${appleScriptString(staging)}`);
  const names = [...wanted];
  for (let i = 0; i < names.length; i += 25) {
    const conditions = names.slice(i, i + 25).map(name => `filename is ${appleScriptString(name)}`).join(' or ');
    await run(`set src to (every media item of album ${appleScriptString(settings.album)} whose ${conditions})\nif (count of src) > 0 then add src to album ${appleScriptString(staging)}`);
  }
  const actual = await albumFiles(staging);
  const { stdout } = await run(`return (count of media items of album ${appleScriptString(staging)}) as text`);
  if (Number(stdout.trim()) !== names.length || actual.size !== wanted.size || names.some(name => !actual.has(name))) {
    throw new Error(`子どものアルバムの中身を確認できません。今のアルバムはそのまま残し、作業用の「${staging}」も残しました`);
  }
  // Rename the old album first, preserving rollback until the new name is confirmed.
  await run(`if (exists album ${appleScriptString(target)}) then set name of album ${appleScriptString(target)} to ${appleScriptString(backup)}`);
  try { await run(`set name of album ${appleScriptString(staging)} to ${appleScriptString(target)}`); }
  catch (error) {
    await run(`if (exists album ${appleScriptString(backup)}) then set name of album ${appleScriptString(backup)} to ${appleScriptString(target)}`);
    throw error;
  }
  const final = await albumFiles(target);
  if (final.size !== wanted.size || names.some(name => !final.has(name))) throw new Error(`子どものアルバムを更新したあとの確認に失敗しました。更新前の「${backup}」を残しました`);
  await run(`if (exists album ${appleScriptString(backup)}) then delete album ${appleScriptString(backup)}`);
}


/** Refresh only the authenticated uploader page; never attach files or click submission. */
export async function refreshMiteneSession(session: Session, options: ConnectorOptions = {}): Promise<Session> {
  const { browser, context } = await contextFor(session, options);
  try { return await refreshMitenePage(await context.newPage(), options); }
  finally { await browser.close(); }
}
export async function refreshMitenePage(page: Page, options: ConnectorOptions = {}): Promise<Session> {
  options.onProgress?.('みてねのログイン状態を確認しています');
  await page.goto(UPLOADER, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== 'mitene.us' || !/^\/web\/uploader\/?$/.test(url.pathname)) throw new Error('みてねに再ログインしてください');
  const input = page.locator('input[type=file]');
  await input.waitFor({ state: 'attached', timeout: 30_000 });
  if (await input.count() !== 1) throw new Error('みてねのログイン状態を確認できません');
  const refreshed = await page.context().storageState();
  await options.onSession?.(refreshed);
  return refreshed;
}
