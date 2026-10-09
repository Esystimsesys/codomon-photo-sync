import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service, dayNow, type Connections, type Vault } from '../src/main/service';
import { Store } from '../src/main/store';
import type { ArchivePhoto, Settings, SyncResult } from '../src/shared/types';
import type { Session } from '../src/main/connectors';
const session: Session = { cookies: [], origins: [] };
async function fixture(overrides: Partial<Settings> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codomon-service-review-'));
  const store = new Store(join(root, 'state.sqlite'));
  const archive = join(root, 'archive'); await mkdir(archive);
  store.saveSettings({ ...store.settings(), saveRoot: archive, importPhotos: false, miteneEnabled: true, initialStartDate: '2026-01-01', setupComplete: true, ...overrides });
  const files: ArchivePhoto[] = [];
  for (const id of ['first.jpeg', 'second.jpeg', 'third.jpeg']) {
    const path = join(archive, id); await writeFile(path, 'synthetic image fixture');
    // 今日届いた写真にする。自動送信は、オンにした日（今日）から後に届いた写真だけを送るため。
    files.push({ id, filename: id, path, date: dayNow(), title: '合成試験', postId: 'synthetic' });
  }
  store.ingest(files, []);
  const messages: string[] = [], uploads: string[][] = [];
  const vault: Vault = { has: () => true, get: () => session, put: () => {} };
  const connections: Connections = {
    manualLogin: async () => session,
    syncCodmon: async () => ({ photos: [], posts: [], errors: [] }),
    importIntoPhotos: async (_s, photos) => ({ imported: photos.map(p => p.id), errors: {} }),
    analyzePhotos: async () => files.map(p => ({ filename: p.filename, person: '対象', selected: true, reason: '' })),
    uploadMitene: async (_s, _session, photos, callback) => {
      uploads.push(photos.map(p => p.id)); callback.beforeSend(photos.map(p => p.id)); callback.onSent(photos.map(p => p.id));
    },
  };
  const service = new Service(store, vault, connections, { changed: () => {}, notify: message => messages.push(message) });
  return { root, archive, store, files, service, connections, vault, uploads, messages, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('automatic sending skips photos that arrived before it was turned on, but they can still be sent by hand', async () => {
  const f = await fixture({ people: [{ name: '対象', album: '' }], sendMode: 'review' });
  try {
    f.store.saveSettings({ ...f.store.settings(), sendMode: 'automatic' }, '2099-01-01');
    f.store.saveSettings({ ...f.store.settings(), syncTimes: ['18:00'] }, '2099-02-01');
    assert.equal(f.store.settings().autoSendFrom, '2099-01-01');
    await f.service.analyze();
    assert.equal(f.uploads.length, 0);
    await f.service.send(['first.jpeg']);
    assert.deepEqual(f.uploads, [['first.jpeg']]);
    f.store.saveSettings({ ...f.store.settings(), sendMode: 'review' });
    assert.equal(f.store.settings().autoSendFrom, '');
  } finally { await f.close(); }
});
test('review mode never sends during sync; automatic mode sends selected only and preserves exclude', async () => {
  const f = await fixture({ people: [{ name: '対象', album: '' }], sendMode: 'review' });
  try {
    f.store.decide(['second.jpeg'], 'exclude');
    await f.service.sync('2026-01-01', '2026-01-02');
    assert.equal(f.uploads.length, 0);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'pending');
    assert.equal(f.store.photo('second.jpeg')?.decision, 'exclude');
    f.store.saveSettings({ ...f.store.settings(), sendMode: 'automatic' });
    await f.service.sync('2026-01-01', '2026-01-02');
    assert.deepEqual(f.uploads, [['first.jpeg', 'third.jpeg']]);
    assert.equal(f.store.photo('second.jpeg')?.uploadState, 'pending');
  } finally { await f.close(); }
});
test('disabled Photos import preserves existing albums while read-only face selection and automatic sending remain available', async () => {
  const f = await fixture({ people: [{ name: '対象', album: '' }], importPhotos: false, sendMode: 'review' });
  let imports = 0, albumWrites = 0;
  try {
    f.connections.importIntoPhotos = async () => { imports++; return { imported: [], errors: {} }; };
    f.connections.updatePersonAlbum = async () => { albumWrites++; };
    f.store.decide(['second.jpeg'], 'exclude');
    assert.ok(f.store.photos().every(p => !p.imported), 'nothing has been imported into Photos yet');
    await f.service.analyze();
    assert.equal(imports, 0); assert.equal(albumWrites, 0);
    assert.equal(f.store.photo('first.jpeg')?.autoSelected, true);
    assert.deepEqual(f.store.eligible().map(p => p.id), ['first.jpeg', 'third.jpeg']);
    assert.equal(f.uploads.length, 0);
    f.store.saveSettings({ ...f.store.settings(), sendMode: 'automatic' });
    await f.service.analyze();
    assert.deepEqual(f.uploads, [['first.jpeg', 'third.jpeg']]);
    assert.equal(imports, 0); assert.equal(albumWrites, 0);
    assert.ok(f.store.photos().every(p => !p.imported));
  } finally { await f.close(); }
});
test('changing the Photos destination reimports existing photos without reopening sent photos or losing manual choices', async () => {
  for (const changed of [{album:'新しい園アルバム'}, {photosLibrary:'/fixture/New.photoslibrary/database/Photos.sqlite'}]) {
    const f = await fixture({importPhotos:true,people:[{name:'対象',album:''}],sendMode:'automatic'});
    try {
      f.store.markImported(f.files.map(p=>p.id), {});
      f.store.applyFaces(f.files.map(p=>({filename:p.filename,person:'対象',selected:true,reason:''})));
      f.store.decide(['second.jpeg'], 'exclude');
      f.store.decide(['third.jpeg'], 'include');
      f.store.markSent(['first.jpeg']);
      const sentAt = f.store.photo('first.jpeg')!.sentAt;
      const next = {...f.store.settings(),...changed};
      f.store.saveSettings(next);
      assert.ok(f.store.photos().every(p=>!p.imported && !p.autoSelected));
      const imports: string[][] = [];
      f.connections.importIntoPhotos = async (settings, photos) => {
        assert.equal(settings.album, next.album);
        assert.equal(settings.photosLibrary, next.photosLibrary);
        imports.push(photos.map(p=>p.id));
        return {imported:photos.map(p=>p.id),errors:{}};
      };
      f.connections.analyzePhotos = async () => {
        assert.equal(imports.length, 1, 'existing photos must be checked in the new destination before face analysis');
        return f.files.map(p=>({filename:p.filename,person:'対象',selected:true,reason:''}));
      };
      await f.service.analyze();
      assert.deepEqual(imports, [f.files.map(p=>p.id)]);
      assert.ok(f.store.photos().every(p=>p.imported && p.autoSelected));
      assert.equal(f.store.photo('second.jpeg')!.decision, 'exclude');
      assert.equal(f.store.photo('third.jpeg')!.decision, 'include');
      assert.equal(f.store.photo('first.jpeg')!.sentAt, sentAt);
      assert.deepEqual(f.uploads, [['third.jpeg']]);
    } finally {await f.close();}
  }
});
test('unrelated settings and child-name changes retain Photos import status', async () => {
  const f = await fixture({people:[{name:'対象',album:''}]});
  try {
    f.store.markImported(f.files.map(p=>p.id), {});
    f.store.applyFaces(f.files.map(p=>({filename:p.filename,person:'対象',selected:true,reason:''})));
    f.store.saveSettings({...f.store.settings(),syncTimes:['08:00']});
    assert.ok(f.store.photos().every(p=>p.imported && p.autoSelected));
    f.store.saveSettings({...f.store.settings(),people:[{name:'別の名前',album:''}]});
    assert.ok(f.store.photos().every(p=>p.imported && !p.autoSelected));
  } finally {await f.close();}
});
test('explicit send is an intentional manual include even when face selection excludes or is pending', async () => {
  const f = await fixture();
  try {
    f.store.decide(['first.jpeg'], 'exclude');
    await f.service.send(['first.jpeg']);
    assert.equal(f.store.photo('first.jpeg')?.decision, 'include');
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'sent');
    assert.equal(f.store.photo('second.jpeg')?.uploadState, 'pending');
    await assert.rejects(f.service.send(['first.jpeg']), /未送信/);
    assert.equal(f.uploads.length, 1);
  } finally { await f.close(); }
});
test('uncertain upload after submit does not retry during later automatic analysis', async () => {
  const f = await fixture({ sendMode: 'automatic' });
  let attempts = 0;
  try {
    f.connections.uploadMitene = async (_s, _session, photos, cb) => { attempts++; cb.beforeSend(photos.map(p => p.id)); throw new Error('submit result timeout'); };
    await assert.rejects(f.service.send(['first.jpeg']), /submit result/);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'uncertain');
    assert.equal(f.service.busy, false);
    await f.service.analyze();
    assert.equal(attempts, 1);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'uncertain');
    assert.equal(f.store.jobs().find(j => j.kind === 'みてねへ送信')?.status, 'error');
  } finally { await f.close(); }
});
test('success callback of first batch survives a later ambiguous batch', async () => {
  const f = await fixture();
  try {
    f.connections.uploadMitene = async (_s, _session, photos, cb) => {
      cb.beforeSend([photos[0].id]); cb.onSent([photos[0].id]);
      cb.beforeSend([photos[1].id]); throw new Error('second batch timeout');
    };
    await assert.rejects(f.service.send(f.files.map(p => p.id)), /second batch/);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'sent');
    assert.equal(f.store.photo('second.jpeg')?.uploadState, 'uncertain');
    assert.equal(f.store.photo('third.jpeg')?.uploadState, 'pending');
    f.connections.uploadMitene = async (_s, _session, photos, cb) => {
      assert.deepEqual(photos.map(p => p.id), ['third.jpeg']); cb.beforeSend(['third.jpeg']); cb.onSent(['third.jpeg']);
    };
    f.store.saveSettings({ ...f.store.settings(), sendMode: 'automatic' });
    await f.service.analyze();
    assert.equal(f.store.photo('third.jpeg')?.uploadState, 'sent');
  } finally { await f.close(); }
});
test('authentication or preflight failures leave pending rather than uncertain', async () => {
  const f = await fixture();
  try {
    f.vault.get = () => { throw new Error('再ログインしてください'); };
    await assert.rejects(f.service.send(['first.jpeg']), /再ログイン/);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'pending'); assert.equal(f.uploads.length, 0);
    f.vault.get = () => session;
    f.connections.uploadMitene = async () => { throw new Error('expired session before click'); };
    await assert.rejects(f.service.send(['first.jpeg']), /expired session/);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'pending');
    await rm(f.files[1].path);
    await assert.rejects(f.service.send(['second.jpeg']), /保存先に見つかりません/);
    assert.equal(f.store.photo('second.jpeg')?.uploadState, 'pending');
  } finally { await f.close(); }
});
test('exclusive operations reject concurrent work and recover after completion', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.connections.manualLogin = () => new Promise<Session>(resolve => { release = () => resolve(session); });
    const pending = f.service.login('codmon');
    assert.equal(f.service.busy, true);
    await assert.rejects(f.service.sync('2026-01-01', '2026-01-02'), /ほかの処理/);
    await assert.rejects(f.service.send(['first.jpeg']), /ほかの処理/);
    assert.equal(f.store.jobs().length, 1);
    release(); await pending;
    assert.equal(f.service.busy, false);
    await f.service.send(['first.jpeg']);
    assert.equal(f.uploads.length, 1);
  } finally { release?.(); await f.close(); }
});
test('scheduler is disabled by default, catches up once per slot, and never overlaps busy work', async () => {
  const f = await fixture({ autoSync: false });
  const calls: string[] = [];
  try {
    f.service.sync = async () => { calls.push('sync'); };
    f.service.analyze = async () => { calls.push('face'); };
    const late = new Date(2026, 9, 3, 23, 0);
    await f.service.scheduled(late); assert.deepEqual(calls, []);
    f.store.saveSettings({ ...f.store.settings(), autoSync: true });
    f.service.options.validation = true;
    await f.service.scheduled(late); assert.deepEqual(calls, [], 'validation never schedules external work');
    assert.equal(f.service.snapshot().demo, false); assert.equal(f.service.snapshot().validation, true);
    f.service.options.validation = false;
    await f.service.scheduled(late); assert.deepEqual(calls, ['sync']);
    assert.equal(f.store.get('syncAttempt'), '2026-10-03 21:00');
    await f.service.scheduled(late); assert.deepEqual(calls, ['sync', 'face']);
    assert.equal(f.store.get('faceAttempt'), '2026-10-03 22:00');
    await f.service.scheduled(late); assert.equal(calls.length, 2);
    f.service.busy = true;
    await f.service.scheduled(new Date(2026, 9, 4, 23, 0)); assert.equal(calls.length, 2);
    f.service.busy = false;
    await f.service.scheduled(new Date(2026, 9, 4, 23, 0)); assert.equal(calls.length, 3);
  } finally { await f.close(); }
});
test('siblings: a photo is a candidate when either child is in it, and each child gets their own album', async () => {
  const f = await fixture({ importPhotos: true, people: [{ name: '上の子', album: '' }, { name: '下の子', album: '' }] });
  const albums: Record<string, string[]> = {};
  try {
    f.connections.updatePersonAlbum = async (_s, person, photos) => { albums[person.name] = photos.map(p => p.id); };
    f.connections.analyzePhotos = async () => [
      { filename: 'first.jpeg', person: '上の子', selected: true, reason: '' },
      { filename: 'second.jpeg', person: '上の子', selected: false, reason: '顔が小さめです（20px・6人）' },
      { filename: 'second.jpeg', person: '下の子', selected: true, reason: '' },
    ];
    // third.jpeg shows neither child: including it sends it, but it joins no child's album.
    f.store.decide(['second.jpeg', 'third.jpeg'], 'include');
    await f.service.analyze();
    assert.deepEqual(albums, { 上の子: ['first.jpeg', 'second.jpeg'], 下の子: ['second.jpeg'] });
    assert.deepEqual(f.store.eligible().map(p => p.id), ['first.jpeg', 'second.jpeg', 'third.jpeg']);
    assert.equal(f.store.photo('first.jpeg')?.reason, '上の子が写っています');
    assert.equal(f.store.photo('third.jpeg')?.reason, '対象の人物が見つかりません');
  } finally { await f.close(); }
});
test('per-photo acquisition/import warnings still send other valid selected photos', async () => {
  const f = await fixture({ sendMode: 'automatic', importPhotos: true, people: [{ name: '対象', album: '' }] });
  try {
    f.connections.syncCodmon = async (): Promise<SyncResult> => ({ photos: [], posts: [], errors: ['一枚取得失敗'] });
    f.connections.importIntoPhotos = async () => ({ imported: ['first.jpeg'], errors: { 'second.jpeg': 'Photos rejected' } });
    f.connections.analyzePhotos = async () => [{ filename: 'first.jpeg', person: '対象', selected: true, reason: '' }];
    await assert.rejects(f.service.sync('2026-01-01', '2026-01-02'), /一部に問題/);
    assert.deepEqual(f.uploads, [['first.jpeg']]);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'sent');
    assert.equal(f.store.photo('second.jpeg')?.uploadState, 'pending');
    assert.equal(f.store.photo('second.jpeg')?.importError, 'Photos rejected');
    assert.deepEqual(f.store.get('pendingSync'), { start: '2026-01-01', end: '2026-01-02' });
  } finally { await f.close(); }
});
test('failed face read retains manual decisions and blocks stale automatic selections', async () => {
  const f = await fixture({ sendMode: 'automatic', people: [{ name: '対象', album: '' }] });
  try {
    f.store.applyFaces([{ filename: 'first.jpeg', person: '対象', selected: true, reason: '' }]);
    f.store.decide(['second.jpeg'], 'exclude');
    f.connections.analyzePhotos = async () => { throw new Error('写真ライブラリを読めません'); };
    await assert.rejects(f.service.sync('2026-01-01', '2026-01-02'), /写真ライブラリ/);
    assert.equal(f.uploads.length, 0);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'pending');
    assert.equal(f.store.photo('second.jpeg')?.decision, 'exclude');
    // Explicit manual sending remains independent from the unavailable face analysis.
    await f.service.send(['third.jpeg']); assert.deepEqual(f.uploads, [['third.jpeg']]);
  } finally { await f.close(); }
});

test('daily acquisition quota covers manual and scheduled work, survives restart and time edits, then resets next day', async t => {
  const day=new Date(2026,9,8,10,0);
  t.mock.timers.enable({apis:['Date'],now:day});
  const f = await fixture({ autoSync: true, miteneEnabled: false, syncTimes: ['09:00','18:00'], faceTimes: ['13:00'] });
  let acquisitions=0,faces=0;
  try {
    f.connections.syncCodmon=async()=>{acquisitions++;return {photos:[],posts:[],errors:[]};};
    await f.service.sync(undefined,undefined,day);
    await f.service.sync('2026-01-01','2026-01-02',day);
    const restarted=new Service(f.store,f.vault,f.connections,{changed:()=>{},notify:()=>{}});
    await assert.rejects(restarted.sync(undefined,undefined,day),/1日2回/);
    f.store.saveSettings({...f.store.settings(),syncTimes:['11:00','19:00']});
    restarted.analyze=async()=>{faces++;};
    await restarted.scheduled(new Date(2026,9,8,20,0));
    await restarted.scheduled(new Date(2026,9,8,20,1));
    assert.equal(acquisitions,2);assert.equal(faces,1,'face updates keep working after the acquisition quota is used');
    t.mock.timers.setTime(new Date(2026,9,9,12,0).getTime());
    await restarted.scheduled();
    assert.equal(acquisitions,3);assert.deepEqual(f.store.get('codmonDailyQuota'),{date:'2026-10-09',count:1});
  } finally {await f.close();}
});
test('failed network attempts consume the quota but invalid dates and missing login do not contact the service', async () => {
  const f=await fixture({miteneEnabled:false});let calls=0;
  const now=new Date(2026,9,8,10,0);
  try {
    f.connections.syncCodmon=async()=>{calls++;throw new Error('simulated network failure');};
    await assert.rejects(f.service.sync('2026-02-30','2026-03-01',now),/期間/);
    assert.equal(f.service.syncQuota(now).count,0);
    const get=f.vault.get;f.vault.get=()=>{throw new Error('ログインしてください');};
    await assert.rejects(f.service.sync('2026-01-01','2026-01-02',now),/ログイン/);
    assert.equal(f.service.syncQuota(now).count,0);f.vault.get=get;
    await assert.rejects(f.service.sync(undefined,undefined,now),/simulated network failure/);
    await assert.rejects(f.service.sync(undefined,undefined,now),/simulated network failure/);
    await assert.rejects(f.service.sync(undefined,undefined,now),/1日2回/);
    assert.equal(calls,2);
  }finally{await f.close();}
});
test('upgrading initializes the daily limit from existing acquisition history', async () => {
  const f=await fixture({miteneEnabled:false});let calls=0;
  const now=new Date(2026,9,8,10,0);
  try {
    const insert=f.store.db.prepare('INSERT INTO jobs(kind,startedAt,endedAt,status,message) VALUES(?,?,?,?,?)');
    for(const status of ['success','error'])insert.run('写真・記録を取得',now.toISOString(),now.toISOString(),status,'fixture');
    f.connections.syncCodmon=async()=>{calls++;return {photos:[],posts:[],errors:[]};};
    await assert.rejects(f.service.sync(undefined,undefined,now),/1日2回/);
    assert.equal(calls,0);assert.equal(f.service.syncQuota(now).count,2);
  }finally{await f.close();}
});
test('scheduler follows edited times, catches up only once and allows disabling each schedule separately', async () => {
  const f=await fixture({autoSync:true,syncTimes:['06:45','14:15'],faceTimes:['10:05']});const calls:string[]=[];
  try {
    f.service.sync=async()=>{calls.push('sync');};f.service.analyze=async()=>{calls.push('face');};
    await f.service.scheduled(new Date(2026,9,8,6,44));assert.deepEqual(calls,[]);
    await f.service.scheduled(new Date(2026,9,8,6,45));assert.deepEqual(calls,['sync']);
    await f.service.scheduled(new Date(2026,9,8,14,20));assert.deepEqual(calls,['sync','sync']);
    await f.service.scheduled(new Date(2026,9,8,14,21));assert.deepEqual(calls,['sync','sync','face']);
    await f.service.scheduled(new Date(2026,9,8,17,30));assert.equal(calls.length,3);
    f.store.saveSettings({...f.store.settings(),syncTimes:[],faceTimes:['18:30']});
    await f.service.scheduled(new Date(2026,9,8,18,30));assert.deepEqual(calls,['sync','sync','face','face']);
    f.store.saveSettings({...f.store.settings(),faceTimes:[]});
    await f.service.scheduled(new Date(2026,9,9,23,0));assert.equal(calls.length,4);
  }finally{await f.close();}
});

test('face history distinguishes unchanged selection from added and removed photos', async () => {
  const f=await fixture({people:[{name:'対象',album:''}],miteneEnabled:false});
  try {
    await f.service.analyze();
    assert.match(f.store.jobs()[0].message,/追加3枚・解除0枚/);
    await f.service.analyze();
    assert.match(f.store.jobs()[0].message,/変更はありません/);
    f.store.decide(['second.jpeg'],'include');
    f.connections.analyzePhotos=async()=>[];
    await f.service.analyze();
    assert.match(f.store.jobs()[0].message,/追加0枚・解除2枚/);
    assert.equal(f.store.photo('second.jpeg')?.decision,'include');
  }finally{await f.close();}
});
