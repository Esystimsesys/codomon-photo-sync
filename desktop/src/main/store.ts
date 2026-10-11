import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { autoSending } from '../shared/send';
import type { ArchivePhoto, ArchivePost, Decision, FaceResult, Job, Person, Photo, Settings, TransferFile, UploadState } from '../shared/types';

export function defaults(home = homedir()): Settings {
  return { saveRoot: join(home, 'Pictures/codomon'), album: 'コドモン', people: [],
    photosLibrary: join(home, 'Pictures/Photos Library.photoslibrary/database/Photos.sqlite'),
    importPhotos: true, sendMode: 'review', miteneEnabled: false, miteneScope: '家族みんなに公開',
    autoSync: false, syncTimes: ['17:30','21:00'], faceTimes: ['07:00','13:00','19:00','22:00'], launchAtLogin: false, initialStartDate: '', faceMinPx: 25,
    faceMinRatio: .6, faceMainRatio: .8, faceMaxPeople: 5, setupComplete: false, autoSendFrom: '' };
}
export function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateTimes(value: unknown, label: string, maximum = 1440): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(t => typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new Error(`${label}の時刻を正しく指定してください${maximum === 2 ? '（1日最大2回）' : ''}`);
  if (new Set(value).size !== value.length) throw new Error(`${label}に同じ時刻が2回指定されています`);
  return [...value].sort();
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('設定の形式が正しくありません');
  const s = value as Settings;
  for (const key of ['saveRoot','photosLibrary'] as const) if (typeof s[key] !== 'string' || !isAbsolute(s[key]) || s[key].includes('\0')) throw new Error('保存先と写真ライブラリは絶対パスで指定してください');
  const name = (value: unknown) => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f]/.test(value);
  if (!name(s.album)) throw new Error('アルバム名が正しくありません');
  if (!s.album.trim()) throw new Error('アルバム名を入力してください');
  if (!Array.isArray(s.people) || s.people.length > 10 || s.people.some(p => !p || typeof p !== 'object' || !name(p.name) || !p.name.trim() || !name(p.album))) throw new Error('子どもの名前・アルバム名が正しくありません');
  const people = s.people.map(p => ({ name: p.name.trim(), album: p.album.trim() }));
  if (new Set(people.map(p => p.name)).size !== people.length) throw new Error('同じ名前の子どもが2回登録されています');
  const albums = people.map(p => personAlbum(s.album, p));
  if (new Set(albums).size !== albums.length || albums.includes(s.album)) throw new Error('子どもごとのアルバムには、取り込み先のアルバムとも、ほかの子のアルバムとも違う名前を付けてください');
  for (const key of ['importPhotos','miteneEnabled','autoSync','launchAtLogin','setupComplete'] as const) if (typeof s[key] !== 'boolean') throw new Error('設定の形式が正しくありません');
  if (!['review','automatic'].includes(s.sendMode) || !['家族みんなに公開','管理者のみ'].includes(s.miteneScope)) throw new Error('送信設定が正しくありません');
  if (s.initialStartDate !== '' && !validDay(s.initialStartDate)) throw new Error('取得開始日が正しくありません');
  const autoSendFrom = s.autoSendFrom ?? '';
  if (autoSendFrom !== '' && !validDay(autoSendFrom)) throw new Error('自動送信の開始日が正しくありません');
  for (const key of ['faceMinPx','faceMinRatio','faceMainRatio','faceMaxPeople'] as const) if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < 0) throw new Error('顔の選別条件が正しくありません');
  if (s.faceMinRatio > 1 || s.faceMainRatio > 1 || s.faceMinPx > 10000 || !Number.isInteger(s.faceMaxPeople) || s.faceMaxPeople > 1000) throw new Error('顔の選別条件が範囲外です');
  const syncTimes = validateTimes(s.syncTimes === undefined ? defaults().syncTimes : s.syncTimes, '同期', 2);
  const faceTimes = validateTimes(s.faceTimes === undefined ? defaults().faceTimes : s.faceTimes, '顔認識の更新');
  // Project only known fields; credentials and renderer-controlled fields never enter settings.
  return { ...Object.fromEntries(Object.keys(defaults()).map(k => [k, s[k as keyof Settings]])), people, syncTimes, faceTimes, autoSendFrom } as unknown as Settings;
}
function localDay(now = new Date()): string { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
export function personAlbum(album: string, person: Person): string { return person.album || `${album}（${person.name}）`; }
/** True only for an existing file inside the archive root, after resolving symlinks. */
export async function archivePathAllowed(path: string, root: string): Promise<boolean> {
  try { const [file, base] = await Promise.all([realpath(path), realpath(root)]); const rel = relative(base, file); return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && (await stat(file)).isFile(); } catch { return false; }
}
export function chosen(p: Photo): boolean { return p.decision === 'include' || (p.decision === 'auto' && p.autoSelected); }
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, filename TEXT NOT NULL, path TEXT NOT NULL, date TEXT NOT NULL, title TEXT NOT NULL, postId TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'auto', autoSelected INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '顔認識の結果待ち',
        uploadState TEXT NOT NULL DEFAULT 'pending', imported INTEGER NOT NULL DEFAULT 0, importError TEXT, sentAt TEXT, postedDate TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS photos_filename ON photos(filename);
      CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(filename TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, status TEXT NOT NULL, message TEXT NOT NULL);
    `);
    // 届いた日の列がない古いデータベースには足す。既存の写真は空のままで、判定には表示日を使う。
    if (!this.db.prepare('PRAGMA table_info(photos)').all().some(c => c.name === 'postedDate')) this.db.exec("ALTER TABLE photos ADD COLUMN postedDate TEXT NOT NULL DEFAULT ''");
    this.db.prepare("UPDATE photos SET uploadState='uncertain' WHERE uploadState='sending'").run();
    // 開始日のない古い設定で自動送信していたら、この版を初めて開いた日を開始日にする。それより前の未送信の写真を、急に自動で送らないため。
    const saved = this.get<Settings>('settings');
    if (saved && autoSending(saved) && !saved.autoSendFrom) this.set('settings', { ...saved, autoSendFrom: localDay() });
    this.db.prepare("UPDATE jobs SET status='error', endedAt=?, message='前回の処理が途中で終了しました。送信できたか分からない写真は、写真画面のお知らせから確認してください。' WHERE status='running'").run(new Date().toISOString());
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get<T>(key: string): T | undefined { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(String(r.value)) : undefined; }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings {
    const s = { ...defaults(), ...this.get<Settings>('settings') };
    // 以前の初期値は「全期間」の意味だったので、記録のある期間をさかのぼる今の動きに読み替える。
    if (s.initialStartDate === '2000-01-01') s.initialStartDate = '';
    return { ...s, syncTimes: validateTimes(s.syncTimes, '同期', 2), faceTimes: validateTimes(s.faceTimes, '顔認識の更新') };
  }
  saveSettings(s: Settings, today = localDay(), carriedAutoSendFrom = ''): void {
    const before = this.settings(), next = validateSettings(s);
    // 開始日は画面からは変えられない。自動送信をオンにした日を残し、オンのまま保存しても動かさない。
    // 別のMacから移したときは、そのMacでオンにした日を引き継ぐ。
    next.autoSendFrom = !autoSending(next) ? '' : carriedAutoSendFrom || (autoSending(before) && before.autoSendFrom ? before.autoSendFrom : today);
    const destinationChanged = next.album !== before.album || next.photosLibrary !== before.photosLibrary;
    this.transaction(() => {
      // Import status belongs to a destination, while manual choices and the send ledger belong to the photo.
      if (destinationChanged) this.db.prepare('UPDATE photos SET imported=0,importError=NULL').run();
      if (destinationChanged || JSON.stringify(next.people.map(p => p.name)) !== JSON.stringify(before.people.map(p => p.name))) {
        this.db.prepare("UPDATE photos SET autoSelected=0,reason='顔認識の結果待ち'").run();
      }
      this.set('settings', next);
    });
  }
  photos(): Photo[] { return this.db.prepare('SELECT * FROM photos ORDER BY date DESC, filename').all().map(r => ({ ...r, autoSelected: !!r.autoSelected, imported: !!r.imported })) as unknown as Photo[]; }
  photo(id: string): Photo | undefined { const r = this.db.prepare('SELECT * FROM photos WHERE id=?').get(id); return r ? { ...r, autoSelected: !!r.autoSelected, imported: !!r.imported } as unknown as Photo : undefined; }
  posts(): ArchivePost[] { return this.db.prepare('SELECT value FROM posts').all().map(r => JSON.parse(String(r.value))).sort((a,b)=>b.date.localeCompare(a.date)); }
  upsertPhotos(photos: ArchivePhoto[]): void {
    const insert = this.db.prepare(`INSERT INTO photos(id,filename,path,date,title,postId,uploadState,sentAt,postedDate) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,path=excluded.path,date=excluded.date,title=excluded.title,postId=excluded.postId,
        postedDate=CASE WHEN excluded.postedDate<>'' THEN excluded.postedDate ELSE photos.postedDate END`);
    // 別のMacで手動で選んだ・外した写真は、このMacに届いたときに反映する。
    const carried = this.get<Record<string, 'include' | 'exclude'>>('carriedDecisions') ?? {};
    let used = false;
    for (const p of photos) {
      const ledger = this.db.prepare('SELECT state,at FROM ledger WHERE filename=?').get(p.filename);
      insert.run(p.id,p.filename,p.path,p.date,p.title,p.postId,ledger ? String(ledger.state) : 'pending',ledger ? String(ledger.at) : null,p.postedDate ?? '');
      if (carried[p.filename]) { this.db.prepare("UPDATE photos SET decision=? WHERE id=? AND decision='auto'").run(carried[p.filename], p.id); delete carried[p.filename]; used = true; }
    }
    if (used) this.set('carriedDecisions', carried);
  }
  exportTransfer(appVersion: string, now = new Date()): TransferFile {
    const ledger = this.db.prepare("SELECT filename,state,at FROM ledger WHERE state IN ('sent','skipped') ORDER BY filename").all()
      .map(r => ({ filename: String(r.filename), state: r.state as 'sent' | 'skipped', at: String(r.at) }));
    const decisions = new Map<string, 'include' | 'exclude'>(Object.entries(this.get<Record<string, 'include' | 'exclude'>>('carriedDecisions') ?? {}));
    for (const r of this.db.prepare("SELECT filename,decision FROM photos WHERE decision IN ('include','exclude') ORDER BY filename").all()) decisions.set(String(r.filename), r.decision as 'include' | 'exclude');
    return { format: 'omukae-photo-transfer', version: 1, exportedAt: now.toISOString(), appVersion, settings: this.settings(),
      ledger, decisions: [...decisions].map(([filename, decision]) => ({ filename, decision })) };
  }
  /**
   * Merges a transfer file from another Mac. Records already on this Mac win: a photo sent or skipped here stays so,
   * and a manual choice made here is kept. This Mac's logins, save folder (once photos exist) and login item stay.
   */
  importTransfer(raw: unknown, today = localDay()): { ledger: number; photos: number; decisions: number } {
    const t = raw as TransferFile;
    if (!t || typeof t !== 'object' || t.format !== 'omukae-photo-transfer') throw new Error('おむかえフォトの移行用ファイルではありません');
    if (t.version !== 1) throw new Error('この移行用ファイルは、このバージョンでは読み込めません。アプリを更新してください');
    const filename = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 500 && !/[\x00-\x1f/]/.test(v);
    if (!Array.isArray(t.ledger) || t.ledger.some(r => !r || !filename(r.filename) || !['sent','skipped'].includes(r.state) || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at)))) throw new Error('移行用ファイルの送信記録が正しくありません');
    if (!Array.isArray(t.decisions) || t.decisions.some(r => !r || !filename(r.filename) || !['include','exclude'].includes(r.decision))) throw new Error('移行用ファイルの写真の選択が正しくありません');
    const imported = validateSettings(t.settings), current = this.settings();
    const hasPhotos = !!this.db.prepare('SELECT 1 FROM photos LIMIT 1').get();
    const carriedFrom = t.settings.autoSendFrom ?? '';
    if (carriedFrom !== '' && !validDay(carriedFrom)) throw new Error('自動送信の開始日が正しくありません');
    this.saveSettings({ ...imported,
      saveRoot: hasPhotos ? current.saveRoot : imported.saveRoot,
      photosLibrary: existsSync(imported.photosLibrary) ? imported.photosLibrary : current.photosLibrary,
      launchAtLogin: current.launchAtLogin, setupComplete: current.setupComplete }, today, carriedFrom);
    return this.transaction(() => {
      let photos = 0, decisions = 0;
      const ledger = this.db.prepare('INSERT INTO ledger VALUES(?,?,?) ON CONFLICT(filename) DO NOTHING');
      const mark = this.db.prepare("UPDATE photos SET uploadState=?,sentAt=? WHERE filename=? AND uploadState IN ('pending','uncertain')");
      for (const r of t.ledger) { ledger.run(r.filename, r.state, r.at); photos += Number(mark.run(r.state, r.at, r.filename).changes); }
      const carried = this.get<Record<string, 'include' | 'exclude'>>('carriedDecisions') ?? {};
      const decide = this.db.prepare("UPDATE photos SET decision=? WHERE filename=? AND decision='auto'");
      for (const r of t.decisions) {
        if (this.db.prepare('SELECT 1 FROM photos WHERE filename=?').get(r.filename)) decisions += Number(decide.run(r.decision, r.filename).changes);
        else carried[r.filename] = r.decision;
      }
      this.set('carriedDecisions', carried);
      return { ledger: t.ledger.length, photos, decisions };
    });
  }
  upsertPosts(posts: ArchivePost[]): void { const q = this.db.prepare('INSERT INTO posts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value'); for (const p of posts) q.run(p.id,JSON.stringify(p)); }
  ingest(photos: ArchivePhoto[], posts: ArchivePost[]): void { this.transaction(()=>{ this.upsertPhotos(photos); this.upsertPosts(posts); }); }
  seedFilenames(names: string[], state: 'sent' | 'skipped' = 'sent'): void {
    const now = new Date().toISOString();
    for (const name of names) {
      this.db.prepare('INSERT INTO ledger VALUES(?,?,?) ON CONFLICT(filename) DO NOTHING').run(name,state,now);
      this.db.prepare("UPDATE photos SET uploadState=?,sentAt=? WHERE filename=? AND uploadState NOT IN ('sent','skipped')").run(state,now,name);
    }
  }
  decide(ids: string[], decision: Decision): void { if (!['auto','include','exclude'].includes(decision)) throw new Error('選別の指定が不正です'); this.transaction(()=>{ for (const id of ids) this.db.prepare('UPDATE photos SET decision=? WHERE id=?').run(decision,id); }); }
  /** A photo is a candidate when any registered child is judged to be in it. */
  applyFaces(faces: FaceResult[]): void {
    const byFile = new Map<string, FaceResult[]>();
    for (const f of faces) byFile.set(f.filename, [...(byFile.get(f.filename) || []), f]);
    const several = this.settings().people.length > 1;
    this.transaction(()=>{
      this.db.prepare("UPDATE photos SET autoSelected=0,reason='対象の人物が見つかりません'").run();
      for (const [filename, found] of byFile) {
        const selected = found.filter(f => f.selected);
        const reason = !several ? found[0].reason || '顔認識で候補になりました'
          : selected.length ? `${selected.map(f => f.person).join('・')}が写っています`
          : found.map(f => `${f.person}：${f.reason}`).join(' / ');
        this.db.prepare('UPDATE photos SET autoSelected=?,reason=? WHERE filename=?').run(selected.length?1:0,reason,filename);
      }
    });
  }
  markImported(ids: string[], errors: Record<string,string>): void {
    this.transaction(()=>{ for (const id of ids) this.db.prepare('UPDATE photos SET imported=1,importError=NULL WHERE id=?').run(id);
      for (const [id,error] of Object.entries(errors)) this.db.prepare('UPDATE photos SET importError=? WHERE id=?').run(error,id); });
  }
  eligible(ids?: string[]): Photo[] { const set = ids ? new Set(ids) : null; return this.photos().filter(p=>p.uploadState==='pending' && chosen(p) && (!set || set.has(p.id))); }
  markSending(ids: string[]): void {
    this.transaction(()=>{ for (const id of ids) { const p=this.photo(id); if (!p || p.uploadState!=='pending' || !chosen(p)) throw new Error('送る写真が変わりました。もう一度確認してから送ってください'); this.db.prepare("UPDATE photos SET uploadState='sending' WHERE id=?").run(id); } });
  }
  markSent(ids: string[]): void { this.transaction(()=>{ for (const id of ids) { const p=this.photo(id); if(p) this.seedFilenames([p.filename]); } }); }
  markUncertain(): void { this.db.prepare("UPDATE photos SET uploadState='uncertain' WHERE uploadState='sending'").run(); }
  resolve(ids: string[], state: 'sent' | 'retry' | 'skipped'): void {
    this.transaction(()=>{ for(const id of ids){ const p=this.photo(id); if(!p || p.uploadState!=='uncertain') throw new Error('送信できたか確認が必要な写真だけを変更できます');
      if(state==='retry') this.db.prepare("UPDATE photos SET uploadState='pending' WHERE id=?").run(id); else this.seedFilenames([p.filename], state);
    } });
  }
  jobs(): Job[] { return this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').all() as unknown as Job[]; }
  startJob(kind: string): number { return Number(this.db.prepare("INSERT INTO jobs(kind,startedAt,status,message) VALUES(?,?,'running','開始しました')").run(kind,new Date().toISOString()).lastInsertRowid); }
  finishJob(id:number,error:string|null,message='完了しました'): void { this.db.prepare('UPDATE jobs SET endedAt=?,status=?,message=? WHERE id=?').run(new Date().toISOString(), error?'error':'success', error||message,id); }
  close(): void { this.db.close(); }
}
