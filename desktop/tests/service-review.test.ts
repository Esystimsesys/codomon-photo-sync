import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Service, type Connections, type Vault } from '../src/main/service';
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
    files.push({ id, filename: id, path, date: '2026-01-01', title: '合成試験', postId: 'synthetic' });
  }
  store.ingest(files, []);
  const messages: string[] = [], uploads: string[][] = [];
  const vault: Vault = { has: () => true, get: () => session, put: () => {} };
  const connections: Connections = {
    manualLogin: async () => session,
    syncCodmon: async () => ({ photos: [], posts: [], errors: [] }),
    importIntoPhotos: async (_s, photos) => ({ imported: photos.map(p => p.id), errors: {} }),
    analyzePhotos: async () => files.map(p => ({ filename: p.filename, selected: true, reason: '' })),
    uploadMitene: async (_s, _session, photos, callback) => {
      uploads.push(photos.map(p => p.id)); callback.beforeSend(photos.map(p => p.id)); callback.onSent(photos.map(p => p.id));
    },
  };
  const service = new Service(store, vault, connections, { changed: () => {}, notify: message => messages.push(message) });
  return { root, archive, store, files, service, connections, vault, uploads, messages, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('review mode never sends during sync; automatic mode sends selected only and preserves exclude', async () => {
  const f = await fixture({ person: '対象', sendMode: 'review' });
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
  const f = await fixture({ person: '対象', importPhotos: false, sendMode: 'review' });
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
    assert.equal(f.store.get('faceAttempt'), '2026-10-03 22');
    await f.service.scheduled(late); assert.equal(calls.length, 2);
    f.service.busy = true;
    await f.service.scheduled(new Date(2026, 9, 4, 23, 0)); assert.equal(calls.length, 2);
    f.service.busy = false;
    await f.service.scheduled(new Date(2026, 9, 4, 23, 0)); assert.equal(calls.length, 3);
  } finally { await f.close(); }
});
test('per-photo acquisition/import warnings still send other valid selected photos', async () => {
  const f = await fixture({ sendMode: 'automatic', importPhotos: true, person: '対象' });
  try {
    f.connections.syncCodmon = async (): Promise<SyncResult> => ({ photos: [], posts: [], errors: ['一枚取得失敗'] });
    f.connections.importIntoPhotos = async () => ({ imported: ['first.jpeg'], errors: { 'second.jpeg': 'Photos rejected' } });
    f.connections.analyzePhotos = async () => [{ filename: 'first.jpeg', selected: true, reason: '' }];
    await assert.rejects(f.service.sync('2026-01-01', '2026-01-02'), /一部に問題/);
    assert.deepEqual(f.uploads, [['first.jpeg']]);
    assert.equal(f.store.photo('first.jpeg')?.uploadState, 'sent');
    assert.equal(f.store.photo('second.jpeg')?.uploadState, 'pending');
    assert.equal(f.store.photo('second.jpeg')?.importError, 'Photos rejected');
    assert.deepEqual(f.store.get('pendingSync'), { start: '2026-01-01', end: '2026-01-02' });
  } finally { await f.close(); }
});
test('failed face read retains manual decisions and blocks stale automatic selections', async () => {
  const f = await fixture({ sendMode: 'automatic', person: '対象' });
  try {
    f.store.applyFaces([{ filename: 'first.jpeg', selected: true, reason: '' }]);
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
