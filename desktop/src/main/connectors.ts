import { chromium, type BrowserContext, type Page } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import piexif from 'piexifjs';
import type { ArchivePhoto, ArchivePost, SyncResult, FaceResult, Settings } from '../shared/types';

export type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface ConnectorOptions {
  executablePath?: string;
  onProgress?: (message: string) => void;
  onSession?: (session: Session) => Promise<void> | void;
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
  return [toText(item.overview || item.content), ...rows.filter(r => r && typeof r === 'object').map(r => `${r.name ?? r.title ?? r.item_name ?? ''} ${r.amount ?? r.price ?? r.total ?? ''}`.trim()).filter(Boolean)].filter(Boolean).join('\n');
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
        const response = await context.request.get(`${API}/my/`, { timeout: 15_000 });
        authenticated = response.status() === 200;
      } else {
        const u = new URL(page.url());
        authenticated = u.hostname === 'mitene.us' && u.pathname.startsWith('/web/uploader') && await page.locator('input[type=file]').count() === 1;
      }
      if (authenticated) { const session = await context.storageState(); await options.onSession?.(session); return session; }
      await page.waitForTimeout(2500);
    }
    throw new Error('ログインの確認が時間切れになりました。再ログインしてください');
  } finally { await browser.close(); }
}
export async function fetchTimeline(request: Pick<BrowserContext['request'], 'get'>, serviceId: string, start: string, end: string): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; page <= 50; page++) {
    const query = new URLSearchParams({ listpage:String(page), 'search_type[]':'new_all', start_date:start, end_date:end, service_id:serviceId, current_flag:'0', use_image_edge:'true', bookmark_only:'false', __env__:'myapp' });
    const r = await request.get(`${API}/timeline/?${query}`);
    if (r.status() !== 200) throw new Error(`記録の取得に失敗しました（HTTP ${r.status()}）`);
    const data = await r.json();
    if (!Array.isArray(data.data)) throw new Error('記録の応答形式が変わっています');
    items.push(...data.data);
    if (!data.next_page) return items;
    if (!data.data.length) throw new Error('記録のページ取得が進みませんでした');
  }
  throw new Error('記録のページ上限に達しました。取得期間を短くしてください');
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
    if ((await request.get(`${API}/my/`)).status() !== 200) throw new Error('コドモンに再ログインしてください');
    const servicesResponse = await request.get(`${API}/services/?__env__=myapp&use_image_edge=true`);
    if (servicesResponse.status() !== 200) throw new Error('施設一覧を取得できません');
    const services = (await servicesResponse.json()).data;
    if (!services || typeof services !== 'object' || Array.isArray(services) || !Object.keys(services).length) throw new Error('利用可能な施設を確認できません');
    const seen = new Set<string>();
    const photoSources = new Map<string, string>();
    for (const serviceId of Object.keys(services)) for (const [start, end] of ranges) {
      options.onProgress?.(`${start} 〜 ${end} の記録を取得しています`);
      let items: Item[];
      try { items = await fetchTimeline(request, serviceId, start, end); }
      catch (e) { result.errors.push(`${start} 〜 ${end}: ${errorText(e)}`); continue; }
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { result.errors.push(`${start}: 記録の形式が正しくありません`); continue; }
        const id = `${serviceId}:${item.timeline_kind || 'unknown'}:${item.id ?? createHash('sha256').update(JSON.stringify(item)).digest('hex')}`;
        if (seen.has(id)) continue; seen.add(id);
        const date = entryDate(item), title = toText(item.title), kind = String(item.timeline_kind || 'unknown');
        const dir = path.join(settings.saveRoot, date);
        const stem = `${safeFilename(id, 200)}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
        const attachments: string[] = [];
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
              const r = await request.get(url);
              if (r.status() !== 200) throw new Error(`HTTP ${r.status()}`);
              const bytes = await r.body();
              if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('JPEG画像ではありません');
              await atomicWrite(dest, date === 'unknown-date' ? bytes : stampExif(bytes, item));
            }
            if (collision) { result.errors.push(`${date}: 同じファイル名の異なる写真を別フォルダに保存しました（${filename}）。確認が必要です`); continue; }
            if (previous === undefined) await atomicWrite(sourceFile, JSON.stringify({ filename, pathname: canonical }));
            photoSources.set(filename, canonical);
            if (date === 'unknown-date') result.errors.push('日付不明の写真を保存しました。写真.appへの取り込みは日付の確認後に行ってください');
            if (!result.photos.some(p => p.id === filename)) result.photos.push({ id: filename, filename, path: dest, date, title, postId: id });
          } catch (e) { result.errors.push(`${date} 写真: ${errorText(e)}`); }
        }
        if (typeof item.file_url === 'string' && item.file_url) {
          try {
            const url = codmonUrl(item.file_url), dest = path.join(dir, '添付', safeFilename(`${stem}-${decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file')}`));
            if (!await exists(dest)) {
              const r = await request.get(url);
              if (r.status() !== 200 || /text\/html/i.test(r.headers()['content-type'] || '')) throw new Error('添付を取得できません');
              await atomicWrite(dest, await r.body());
            }
            attachments.push(dest);
          } catch (e) { result.errors.push(`${date} 添付: ${errorText(e)}`); }
        }
        const body = recordBody(item), markdown = path.join(dir, '記録', `${stem}.md`);
        try {
          // Per-post files preserve earlier services, months and records on partial retrieval failures.
          await atomicWrite(path.join(dir, '記録', `${stem}.json`), JSON.stringify(item, null, 2));
          const link = (dest: string) => path.relative(path.dirname(markdown), dest).split(path.sep).map(encodeURIComponent).join('/');
          const photoLinks = result.photos.filter(p => p.postId === id).map(p => `![写真](${link(p.path)})`);
          const attachmentLinks = attachments.map(p => `[添付ファイル](${link(p)})`);
          await atomicWrite(markdown, `# ${date} ${title}\n\n${kind}\n\n${body}\n\n${[...photoLinks, ...attachmentLinks].join('\n\n')}\n`);
          result.posts.push({ id, date, kind, title, body, path: markdown, attachments });
        } catch (e) { result.errors.push(`${date} 記録保存: ${errorText(e)}`); }
      }
    }
    return result;
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
      throw new Error(disconnected ? '写真.appとの接続が切れたため、アルバムの写真を確認できませんでした。次の自動実行で再試行します' : '写真.appのアルバムを読み取れません。写真.appとオートメーション権限を確認してください');
    }
  }
}
export async function importIntoPhotos(settings: Settings, photos: ArchivePhoto[]): Promise<{ imported: string[]; errors: Record<string, string> }> {
  if (process.platform !== 'darwin') throw new Error('写真.appへの取り込みはMacのみ対応しています');
  const imported: string[] = [], errors: Record<string, string> = {};
  const have = await albumFilenames(settings.album);
  const todo = photos.filter(p => { if (p.date === 'unknown-date') { errors[p.id] = '撮影日を確認できないため取り込みを保留しています'; return false; } if (have.has(p.filename)) { imported.push(p.id); return false; } return true; });
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    try {
      await exec('/usr/bin/osascript', ['-e', `on run argv\nset fileList to {}\nrepeat with p in argv\nset end of fileList to (POSIX file (contents of p)) as alias\nend repeat\nwith timeout of 1800 seconds\ntell application "Photos"\nif not (exists album ${appleScriptString(settings.album)}) then make new album named ${appleScriptString(settings.album)}\nimport fileList into album ${appleScriptString(settings.album)} skip check duplicates false\nend tell\nend timeout\nend run`, ...chunk.map(p => p.path)], { timeout: 1_810_000 });
      const after = await albumFilenames(settings.album);
      for (const p of chunk) if (after.has(p.filename)) imported.push(p.id); else errors[p.id] = '取り込みを確認できません（内容重複の可能性）。写真.appを確認してください';
    } catch { for (const p of chunk) errors[p.id] = '写真.appへの取り込みに失敗しました。オートメーション権限を確認してください'; }
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
  if (!settings.person) return [];
  const pk = db.prepare('SELECT Z_PK FROM ZGENERICALBUM WHERE ZTITLE = ? AND ZTRASHEDSTATE = 0 ORDER BY ZCACHEDCOUNT DESC LIMIT 1').get(settings.album)?.Z_PK;
  if (!pk) return [];
  let join: { table: string; album: string; asset: string } | undefined;
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'Z_[0-9]*ASSETS' ORDER BY name").all()) {
    const table = String(row.name);
    const cols = db.prepare(`PRAGMA table_info(${identifier(table)})`).all().map(c => String(c.name));
    const album = cols.find(c => c.endsWith('ALBUMS')), asset = cols.find(c => c.endsWith('ASSETS') && !c.startsWith('Z_FOK_'));
    if (album && asset) { join = { table, album, asset }; break; }
  }
  if (!join) throw new Error('この写真ライブラリの形式には対応していません。候補は手動で選んでください');
  const rows = db.prepare(`SELECT f.ZASSETFORFACE asset, aa.ZORIGINALFILENAME name, p.ZFULLNAME person, f.ZSIZE size, f.ZSOURCEWIDTH width FROM ZDETECTEDFACE f JOIN ${identifier(join.table)} a ON a.${identifier(join.asset)}=f.ZASSETFORFACE JOIN ZADDITIONALASSETATTRIBUTES aa ON aa.ZASSET=f.ZASSETFORFACE LEFT JOIN ZPERSON p ON p.Z_PK=f.ZPERSONFORFACE WHERE a.${identifier(join.album)}=?`).all(pk);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const key = String(r.asset); groups.set(key, [...(groups.get(key) || []), r]); }
  const out: FaceResult[] = [];
  for (const dets of groups.values()) {
    const mine = dets.filter(r => r.person === settings.person && r.name);
    if (!mine.length) continue;
    const best = mine.reduce((a, b) => Number(a.size) >= Number(b.size) ? a : b);
    const largest = Math.max(...dets.map(r => Number(r.size) || 0));
    const px = Number(best.size) * Number(best.width), ratio = largest > 0 ? Number(best.size) / largest : 0;
    const reason = judgeFace(px, ratio, dets.length, settings);
    out.push({ filename: String(best.name), selected: !reason, reason });
  }
  return out;
}
export async function analyzePhotos(settings: Settings): Promise<FaceResult[]> {
  if (process.platform !== 'darwin') throw new Error('写真.appの顔認識はMacのみ対応しています');
  const filename = settings.photosLibrary.endsWith('.sqlite') ? settings.photosLibrary : path.join(settings.photosLibrary, 'database', 'Photos.sqlite');
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(filename, { readOnly: true }); db.exec('PRAGMA busy_timeout=30000'); return readFaceResults(db, settings); }
  catch { throw new Error('写真ライブラリを読めません。写真.appを開き、ライブラリの場所とフルディスクアクセス権限を確認してください'); }
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
      if (await input.count() !== 1) throw new Error('みてねの写真選択画面が変わっています');
      if (confirmedUploadCount(await page.innerText('body')) !== null) throw new Error('前回の完了表示が残っています。送信を中止しました');
      await input.setInputFiles(chunk.map(p => p.path));
      const button = page.getByRole('button', { name: settings.miteneScope, exact: true });
      await button.waitFor({ state: 'visible', timeout: 30_000 });
      if (await button.count() !== 1) throw new Error('公開範囲を一意に確認できません。送信を中止しました');
      await callbacks.beforeSend(chunk.map(p => p.id));
      // From this point an exception is ambiguous, including a click timeout. Never retry automatically.
      try {
        await button.click();
        await page.waitForFunction((count: number) => {
          const match = document.body.innerText.match(/(?:^|\D)(\d+)\s*点のアップロードが完了しました/);
          return match !== null && Number(match[1]) === count;
        }, chunk.length, { timeout: 180_000 });
        await callbacks.onSent(chunk.map(p => p.id));
      } catch { throw new Error('送信結果を確認できません。みてねを確認し、送信済みか再試行かを選んでください'); }
      options.onProgress?.(`${Math.min(i + 20, photos.length)} / ${photos.length} 枚を送信しました`);
    }
}

/** Rebuild only album references. Original media assets are never deleted. */
export interface AlbumAdapter {
  run(body: string): Promise<{ stdout: string }>;
  albumFiles(album: string): Promise<Set<string>>;
}
export async function updatePersonAlbum(settings: Settings, selected: ArchivePhoto[]): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('写真.appのアルバム更新はMacのみ対応しています');
  await updatePersonAlbumWith(settings, selected, {
    run: async body => exec('/usr/bin/osascript', ['-e', `with timeout of 900 seconds\ntell application "Photos"\n${body}\nend tell\nend timeout`], { timeout: 910_000 }),
    albumFiles: albumFilenames,
  });
}
export async function updatePersonAlbumWith(settings: Settings, selected: ArchivePhoto[], adapter: AlbumAdapter): Promise<void> {
  const { run, albumFiles } = adapter;
  if (!settings.person) return;
  const target = settings.personAlbum || `${settings.album}（${settings.person}）`;
  if (target === settings.album) throw new Error('人物アルバムと取り込み先には異なる名前を指定してください');
  const { stdout: counts } = await run(`return ((count of (every album whose name is ${appleScriptString(settings.album)})) as text) & "," & ((count of (every album whose name is ${appleScriptString(target)})) as text)`);
  const [sourceCount, targetCount] = counts.trim().split(',').map(Number);
  if (sourceCount !== 1 || targetCount > 1 || !Number.isFinite(targetCount)) throw new Error('同名のアルバムが複数あるか、取り込み先がありません。アルバム名を確認してください');
  const wanted = new Set(selected.map(p => p.filename));
  const before = await albumFiles(target);
  if (wanted.size === before.size && [...wanted].every(name => before.has(name))) return;
  const source = await albumFiles(settings.album);
  if ([...wanted].some(name => !source.has(name))) throw new Error('人物アルバムに必要な写真が取り込み先にありません。既存アルバムは保持しました');
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
    throw new Error(`人物アルバムの内容を確認できません。既存アルバムを保持し、${staging} を残しました`);
  }
  // Rename the old album first, preserving rollback until the new name is confirmed.
  await run(`if (exists album ${appleScriptString(target)}) then set name of album ${appleScriptString(target)} to ${appleScriptString(backup)}`);
  try { await run(`set name of album ${appleScriptString(staging)} to ${appleScriptString(target)}`); }
  catch (error) {
    await run(`if (exists album ${appleScriptString(backup)}) then set name of album ${appleScriptString(backup)} to ${appleScriptString(target)}`);
    throw error;
  }
  const final = await albumFiles(target);
  if (final.size !== wanted.size || names.some(name => !final.has(name))) throw new Error(`人物アルバム更新後の確認に失敗しました。${backup} を保持しました`);
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
