import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { ArchivePhoto, ArchivePost, Decision, FaceResult, Job, Photo, Settings, UploadState } from '../shared/types';

export function defaults(home = homedir()): Settings {
  return { saveRoot: join(home, 'Pictures/codomon'), album: 'コドモン', person: '', personAlbum: '',
    photosLibrary: join(home, 'Pictures/Photos Library.photoslibrary/database/Photos.sqlite'),
    importPhotos: true, sendMode: 'review', miteneEnabled: false, miteneScope: '家族みんなに公開',
    autoSync: false, launchAtLogin: false, initialStartDate: '2000-01-01', faceMinPx: 25,
    faceMinRatio: .6, faceMainRatio: .8, faceMaxPeople: 5, setupComplete: false };
}
export function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('設定の形式が正しくありません');
  const s = value as Settings;
  for (const key of ['saveRoot','photosLibrary'] as const) if (typeof s[key] !== 'string' || !isAbsolute(s[key]) || s[key].includes('\0')) throw new Error('保存先と写真ライブラリは絶対パスで指定してください');
  for (const key of ['album','person','personAlbum'] as const) if (typeof s[key] !== 'string' || s[key].length > 200 || /[\x00-\x1f]/.test(s[key])) throw new Error('アルバム名・人物名が正しくありません');
  if (!s.album.trim()) throw new Error('アルバム名を入力してください');
  for (const key of ['importPhotos','miteneEnabled','autoSync','launchAtLogin','setupComplete'] as const) if (typeof s[key] !== 'boolean') throw new Error('設定の形式が正しくありません');
  if (!['review','automatic'].includes(s.sendMode) || !['家族みんなに公開','管理者のみ'].includes(s.miteneScope)) throw new Error('送信設定が正しくありません');
  if (!validDay(s.initialStartDate)) throw new Error('取得開始日が正しくありません');
  for (const key of ['faceMinPx','faceMinRatio','faceMainRatio','faceMaxPeople'] as const) if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < 0) throw new Error('顔の選別条件が正しくありません');
  if (s.faceMinRatio > 1 || s.faceMainRatio > 1 || s.faceMinPx > 10000 || !Number.isInteger(s.faceMaxPeople) || s.faceMaxPeople > 1000) throw new Error('顔の選別条件が範囲外です');
  // Project only known fields; credentials and renderer-controlled fields never enter settings.
  return Object.fromEntries(Object.keys(defaults()).map(k => [k, s[k as keyof Settings]])) as unknown as Settings;
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
        uploadState TEXT NOT NULL DEFAULT 'pending', imported INTEGER NOT NULL DEFAULT 0, importError TEXT, sentAt TEXT);
      CREATE INDEX IF NOT EXISTS photos_filename ON photos(filename);
      CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(filename TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, status TEXT NOT NULL, message TEXT NOT NULL);
    `);
    this.db.prepare("UPDATE photos SET uploadState='uncertain' WHERE uploadState='sending'").run();
    this.db.prepare("UPDATE jobs SET status='error', endedAt=?, message='前回の処理が途中で終了しました。送信できたか不明な写真は、写真画面の「要確認」で確認してください。' WHERE status='running'").run(new Date().toISOString());
  }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get<T>(key: string): T | undefined { const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return r ? JSON.parse(String(r.value)) : undefined; }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings { return { ...defaults(), ...this.get<Settings>('settings') }; }
  saveSettings(s: Settings): void { this.set('settings', validateSettings(s)); }
  photos(): Photo[] { return this.db.prepare('SELECT * FROM photos ORDER BY date DESC, filename').all().map(r => ({ ...r, autoSelected: !!r.autoSelected, imported: !!r.imported })) as unknown as Photo[]; }
  photo(id: string): Photo | undefined { const r = this.db.prepare('SELECT * FROM photos WHERE id=?').get(id); return r ? { ...r, autoSelected: !!r.autoSelected, imported: !!r.imported } as unknown as Photo : undefined; }
  posts(): ArchivePost[] { return this.db.prepare('SELECT value FROM posts').all().map(r => JSON.parse(String(r.value))).sort((a,b)=>b.date.localeCompare(a.date)); }
  upsertPhotos(photos: ArchivePhoto[]): void {
    const insert = this.db.prepare(`INSERT INTO photos(id,filename,path,date,title,postId,uploadState,sentAt) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,path=excluded.path,date=excluded.date,title=excluded.title,postId=excluded.postId`);
    for (const p of photos) {
      const ledger = this.db.prepare('SELECT state,at FROM ledger WHERE filename=?').get(p.filename);
      insert.run(p.id,p.filename,p.path,p.date,p.title,p.postId,ledger ? String(ledger.state) : 'pending',ledger ? String(ledger.at) : null);
    }
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
  applyFaces(faces: FaceResult[]): void {
    this.transaction(()=>{
      this.db.prepare("UPDATE photos SET autoSelected=0,reason='対象の人物が見つかりません'").run();
      for (const f of faces) this.db.prepare('UPDATE photos SET autoSelected=?,reason=? WHERE filename=?').run(f.selected?1:0,f.reason || '顔認識で候補になりました',f.filename);
    });
  }
  markImported(ids: string[], errors: Record<string,string>): void {
    this.transaction(()=>{ for (const id of ids) this.db.prepare('UPDATE photos SET imported=1,importError=NULL WHERE id=?').run(id);
      for (const [id,error] of Object.entries(errors)) this.db.prepare('UPDATE photos SET importError=? WHERE id=?').run(error,id); });
  }
  eligible(ids?: string[]): Photo[] { const set = ids ? new Set(ids) : null; return this.photos().filter(p=>p.uploadState==='pending' && chosen(p) && (!set || set.has(p.id))); }
  markSending(ids: string[]): void {
    this.transaction(()=>{ for (const id of ids) { const p=this.photo(id); if (!p || p.uploadState!=='pending' || !chosen(p)) throw new Error('送信対象が変更されました。再確認してください'); this.db.prepare("UPDATE photos SET uploadState='sending' WHERE id=?").run(id); } });
  }
  markSent(ids: string[]): void { this.transaction(()=>{ for (const id of ids) { const p=this.photo(id); if(p) this.seedFilenames([p.filename]); } }); }
  markUncertain(): void { this.db.prepare("UPDATE photos SET uploadState='uncertain' WHERE uploadState='sending'").run(); }
  resolve(ids: string[], state: 'sent' | 'retry' | 'skipped'): void {
    this.transaction(()=>{ for(const id of ids){ const p=this.photo(id); if(!p || p.uploadState!=='uncertain') throw new Error('結果確認待ちの写真だけを変更できます');
      if(state==='retry') this.db.prepare("UPDATE photos SET uploadState='pending' WHERE id=?").run(id); else this.seedFilenames([p.filename], state);
    } });
  }
  jobs(): Job[] { return this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').all() as unknown as Job[]; }
  startJob(kind: string): number { return Number(this.db.prepare("INSERT INTO jobs(kind,startedAt,status,message) VALUES(?,?,'running','開始しました')").run(kind,new Date().toISOString()).lastInsertRowid); }
  finishJob(id:number,error:string|null,message='完了しました'): void { this.db.prepare('UPDATE jobs SET endedAt=?,status=?,message=? WHERE id=?').run(new Date().toISOString(), error?'error':'success', error||message,id); }
  close(): void { this.db.close(); }
}
