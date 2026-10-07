import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, archivePathAllowed, defaults, chosen, validateSettings } from '../src/main/store';
import type { ArchivePhoto } from '../src/shared/types';
import { Service, dayNow, type Connections } from '../src/main/service';

function photo(id: string, filename = `${id}.jpeg`): ArchivePhoto {
  return { id, filename, path: `/fixture/2026-09-01/${filename}`, date: '2026-09-01', title: 'fixture', postId: 'fixture:post' };
}
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codomon-review-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('missing historical uploads remain tombstoned when discovered later', () => {
  const store = new Store(':memory:');
  try {
    store.seedFilenames(['old.jpeg', 'not-yet-downloaded.jpeg']);
    store.upsertPhotos([photo('new-id', 'not-yet-downloaded.jpeg'), photo('new')]);
    store.decide(['new-id', 'new'], 'include');
    assert.equal(store.photo('new-id')?.uploadState, 'sent');
    assert.deepEqual(store.eligible().map(p => p.id), ['new']);
  } finally { store.close(); }
});

test('sibling names and albums must not collide', () => {
  {
    const base = defaults('/fixture');
    assert.deepEqual(validateSettings({ ...base, people: [{ name: ' 上の子 ', album: '' }, { name: '下の子', album: '' }] }).people, [{ name: '上の子', album: '' }, { name: '下の子', album: '' }]);
    assert.throws(() => validateSettings({ ...base, people: [{ name: '上の子', album: '' }, { name: '上の子', album: 'x' }] }), /2回/);
    assert.throws(() => validateSettings({ ...base, people: [{ name: '上の子', album: '共通' }, { name: '下の子', album: '共通' }] }), /違う名前/);
    assert.throws(() => validateSettings({ ...base, people: [{ name: '上の子', album: base.album }] }), /違う名前/);
  }
});
test('manual include and exclude survive face reanalysis and source corrections', () => {
  const store = new Store(':memory:');
  try {
    store.upsertPhotos([photo('include'), photo('exclude')]);
    store.decide(['include'], 'include'); store.decide(['exclude'], 'exclude');
    store.applyFaces([{ filename: 'exclude.jpeg', person: '対象', selected: true, reason: 'face' }]);
    store.upsertPhotos([{ ...photo('include'), title: 'edited' }, { ...photo('exclude'), date: '2026-09-02' }]);
    assert.equal(chosen(store.photo('include')!), true);
    assert.equal(chosen(store.photo('exclude')!), false);
    assert.equal(store.photo('include')?.title, 'edited');
    assert.deepEqual(store.eligible().map(p => p.id), ['include']);
  } finally { store.close(); }
});

test('changing selection never reopens a confirmed upload', () => {
  const store = new Store(':memory:');
  try {
    store.upsertPhotos([photo('sent')]); store.decide(['sent'], 'include');
    store.markSending(['sent']); store.markSent(['sent']);
    store.decide(['sent'], 'exclude'); store.decide(['sent'], 'include');
    store.upsertPhotos([{ ...photo('sent'), title: 'new title' }]);
    assert.equal(store.photo('sent')?.uploadState, 'sent');
    assert.deepEqual(store.eligible(), []);
  } finally { store.close(); }
});

test('a partially invalid send batch rolls back every sending marker', () => {
  const store = new Store(':memory:');
  try {
    store.upsertPhotos([photo('selected'), photo('not-selected')]); store.decide(['selected'], 'include');
    assert.throws(() => store.markSending(['selected', 'not-selected']));
    assert.equal(store.photo('selected')?.uploadState, 'pending');
  } finally { store.close(); }
});

test('restart makes unfinished uploads uncertain and requires explicit resolution', async () => temporary(async root => {
  const filename = join(root, 'state.sqlite');
  let store = new Store(filename);
  store.upsertPhotos([photo('interrupted'), photo('done')]); store.decide(['interrupted', 'done'], 'include');
  store.markSending(['done']); store.markSent(['done']); store.markSending(['interrupted']); store.startJob('send');
  store.close(); store = new Store(filename);
  try {
    assert.equal(store.photo('interrupted')?.uploadState, 'uncertain');
    assert.equal(store.photo('done')?.uploadState, 'sent');
    assert.deepEqual(store.eligible(), []);
    assert.equal(store.jobs()[0].status, 'error');
    assert.throws(() => store.resolve(['done'], 'retry'));
    store.resolve(['interrupted'], 'retry');
    assert.deepEqual(store.eligible().map(p => p.id), ['interrupted']);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  } finally { store.close(); }
}));

test('uncertain result can be marked sent or intentionally skipped without resending', () => {
  const store = new Store(':memory:');
  try {
    store.upsertPhotos([photo('sent'), photo('skipped')]); store.decide(['sent', 'skipped'], 'include');
    store.markSending(['sent', 'skipped']); store.markUncertain();
    store.resolve(['sent'], 'sent'); store.resolve(['skipped'], 'skipped');
    assert.equal(store.photo('sent')?.uploadState, 'sent');
    assert.equal(store.photo('skipped')?.uploadState, 'skipped');
    assert.deepEqual(store.eligible(), []);
  } finally { store.close(); }
});

test('settings validate dates and strip unknown session material', () => {
  const value = validateSettings({ ...defaults('/fixture'), cookies: ['secret'], password: 'secret' });
  assert.equal('cookies' in value, false); assert.equal('password' in value, false);
  assert.throws(() => validateSettings({ ...value, initialStartDate: '2026-02-30' }));
  assert.throws(() => validateSettings({ ...value, saveRoot: '../relative' }));
  assert.throws(() => validateSettings({ ...value, faceMinRatio: Number.NaN }));
});

test('archive opener rejects directories, sibling roots and symlink escapes', async () => temporary(async root => {
  const archive = join(root, 'archive'), sibling = join(root, 'archive-other');
  await mkdir(archive); await mkdir(sibling);
  const safe = join(archive, 'note.md'), outside = join(sibling, 'note.md');
  await writeFile(safe, 'synthetic'); await writeFile(outside, 'synthetic');
  await symlink(outside, join(archive, 'escape.md'));
  assert.equal(await archivePathAllowed(safe, archive), true);
  for (const candidate of [archive, outside, join(archive, 'escape.md'), join(archive, 'absent.md')]) {
    assert.equal(await archivePathAllowed(candidate, archive), false);
  }
}));

function syncFixture(store: Store, ranges: string[][]): Service {
  store.saveSettings({ ...store.settings(), importPhotos: false });
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected connector call in acquisition fixture'); };
  const connectors: Connections = {
    manualLogin: unexpected, importIntoPhotos: unexpected, analyzePhotos: unexpected, uploadMitene: unexpected,
    syncCodmon: async (_settings, _session, start, end) => { ranges.push([start, end]); return { photos: [], posts: [], errors: [] }; },
  };
  return new Service(store, { has: () => true, get: () => ({ cookies: [], origins: [] }), put: () => {} }, connectors,
    { changed: () => {}, notify: () => {} });
}

test('incremental acquisition catches up beyond thirty days after a long offline period', async () => {
  const store = new Store(':memory:');
  try {
    const ranges: string[][] = [], service = syncFixture(store, ranges);
    const last = new Date(); last.setDate(last.getDate() - 90);
    store.set('lastSync', last.toISOString());
    await service.sync();
    assert.ok(ranges[0][0] <= dayNow(last), `start ${ranges[0][0]} skips history after ${dayNow(last)}`);
  } finally { store.close(); }
});

test('a successful custom date request cannot erase an older unfinished archive range', async () => {
  const store = new Store(':memory:');
  try {
    const ranges: string[][] = [], service = syncFixture(store, ranges);
    store.set('pendingSync', { start: '2025-01-01', end: '2026-08-31' });
    await service.sync('2026-09-01', '2026-09-30');
    const pending = store.get<{ start: string; end: string } | null>('pendingSync');
    assert.ok(ranges[0][0] <= '2025-01-01' || pending && pending.start <= '2025-01-01', 'earlier pending history must be acquired or retained');
  } finally { store.close(); }
});

test('historical manual acquisition cannot advance the incremental checkpoint past an offline gap', async () => {
  const store = new Store(':memory:');
  try {
    const ranges: string[][] = [], service = syncFixture(store, ranges);
    const last = new Date(); last.setDate(last.getDate() - 90);
    store.set('lastSync', last.toISOString());
    await service.sync('2025-01-01', '2025-01-31');
    await service.sync();
    assert.ok(ranges[1][0] <= dayNow(last), `manual archive query advanced checkpoint past ${dayNow(last)} to ${ranges[1][0]}`);
  } finally { store.close(); }
});

test('schedule settings normalize times, reject duplicates and limit acquisition to two slots', () => {
  const base=defaults('/fixture');
  assert.deepEqual(validateSettings({...base,syncTimes:['21:00','17:30'],faceTimes:[]}).syncTimes,['17:30','21:00']);
  assert.deepEqual(validateSettings({...base,syncTimes:[]}).syncTimes,[]);
  for(const syncTimes of [['08:00','12:00','18:00'],['08:00','08:00'],['24:00'],['9:30'],null])assert.throws(()=>validateSettings({...base,syncTimes}));
  assert.throws(()=>validateSettings({...base,faceTimes:['13:00','13:00']}));
  const legacy={...base} as Partial<typeof base>;delete legacy.syncTimes;delete legacy.faceTimes;
  assert.deepEqual(validateSettings(legacy).syncTimes,['17:30','21:00']);
  const store=new Store(':memory:');try{store.set('settings',legacy);assert.deepEqual(store.settings().faceTimes,['07:00','13:00','19:00','22:00']);}finally{store.close();}
});
