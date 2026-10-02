import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, defaults, chosen, validateSettings } from '../src/main/store';
import { inspectLegacy, legacyLedger, archivePathAllowed, pauseLegacy, type LegacyCommandRunner, type LegacyJob } from '../src/main/migration';
import type { ArchivePhoto } from '../src/shared/types';
import { Service, dayNow, type Connections } from '../src/main/service';

function photo(id: string, filename = `${id}.jpeg`): ArchivePhoto {
  return { id, filename, path: `/fixture/2026-09-01/${filename}`, date: '2026-09-01', title: 'fixture', postId: 'fixture:post' };
}
async function temporary(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'codomon-review-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('legacy ledger retains unmatched filenames and rejects corrupt history', () => {
  assert.deepEqual(legacyLedger(['old.jpeg', 'missing.jpeg', 'old.jpeg']), ['old.jpeg', 'missing.jpeg']);
  assert.deepEqual(legacyLedger(undefined), []);
  for (const invalid of [null, {}, [''], ['../a.jpeg'], ['a/b.jpeg'], [42], ['a\0.jpeg']]) {
    assert.throws(() => legacyLedger(invalid));
  }
});

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

test('manual include and exclude survive face reanalysis and source corrections', () => {
  const store = new Store(':memory:');
  try {
    store.upsertPhotos([photo('include'), photo('exclude')]);
    store.decide(['include'], 'include'); store.decide(['exclude'], 'exclude');
    store.applyFaces([{ filename: 'exclude.jpeg', selected: true, reason: 'face' }]);
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

async function legacyFixture(root: string) {
  const source = join(root, 'legacy'), archive = join(root, 'archive');
  await mkdir(source); await mkdir(join(archive, '2026-09-01'), { recursive: true });
  await mkdir(join(archive, 'unknown-date'));
  await writeFile(join(source, 'config.json'), JSON.stringify({ save_root: archive, person: 'Fixture Child', album: 'Fixture Album' }));
  await writeFile(join(source, 'mitene_uploaded.json'), JSON.stringify(['sent.jpeg', 'future.jpeg']));
  await writeFile(join(source, 'photos_skip.json'), JSON.stringify(['not-sent.jpeg']));
  await writeFile(join(archive, '2026-09-01', 'sent.jpeg'), 'synthetic');
  await writeFile(join(archive, '2026-09-01', 'not-sent.jpeg'), 'synthetic');
  await writeFile(join(archive, 'unknown-date', 'undated.jpeg'), 'synthetic');
  await writeFile(join(archive, '2026-09-01', 'posts.json'), JSON.stringify([{ id: 1, timeline_kind: 'bills', data: [{ amount: 0 }] }]));
  await writeFile(join(archive, '2026-09-01', '記録.md'), '# synthetic bill');
  return { source, archive };
}

test('legacy migration is repeatable, retains undated assets and never confuses Photos skips with sent history', async () => temporary(async root => {
  const { source } = await legacyFixture(root);
  const migration = await inspectLegacy(source, defaults('/fixture'));
  assert.equal(migration.settings.sendMode, 'review'); assert.equal(migration.settings.autoSync, false);
  assert.equal(migration.photos.length, 3); assert.equal(migration.posts.length, 1);
  assert.ok(migration.photos.some(p => p.date === 'unknown-date'));
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 2; i++) {
      store.seedFilenames(migration.ledger); store.ingest(migration.photos, migration.posts);
    }
    assert.equal(store.photos().length, 3); assert.equal(store.posts().length, 1);
    assert.equal(store.photos().find(p => p.filename === 'sent.jpeg')?.uploadState, 'sent');
    assert.equal(store.photos().find(p => p.filename === 'not-sent.jpeg')?.uploadState, 'pending');
    store.decide(['not-sent.jpeg'], 'exclude');
    store.upsertPhotos([photo('not-sent.jpeg', 'not-sent.jpeg')]);
    assert.equal(store.photos().length, 3);
    assert.equal(store.photo('not-sent.jpeg')?.decision, 'exclude');
    store.upsertPhotos([photo('later', 'future.jpeg')]);
    assert.equal(store.photo('later')?.uploadState, 'sent');
  } finally { store.close(); }
}));

test('existing mitene session without a ledger refuses unsafe migration, but explicit empty ledger is valid', async () => temporary(async root => {
  const { source } = await legacyFixture(root);
  await writeFile(join(source, 'mitene_state.json'), JSON.stringify({ cookies: [], origins: [] }));
  await rm(join(source, 'mitene_uploaded.json'));
  await assert.rejects(() => inspectLegacy(source, defaults('/fixture')), /送信履歴が見つかりません/);
  await writeFile(join(source, 'mitene_uploaded.json'), '[]');
  const migration = await inspectLegacy(source, defaults('/fixture'));
  assert.equal(migration.settings.miteneEnabled, true);
  assert.deepEqual(migration.ledger, []);
}));

test('byte-identical legacy filenames across date folders coalesce without changing sources or ledger', async () => temporary(async root => {
  const { source, archive } = await legacyFixture(root);
  await mkdir(join(archive, '2026-09-02'));
  const duplicate = join(archive, '2026-09-02', 'sent.jpeg');
  await writeFile(duplicate, 'synthetic');
  const beforeLedger = await readFile(join(source, 'mitene_uploaded.json'));
  const migration = await inspectLegacy(source, defaults('/fixture'));
  assert.equal(migration.photos.length, 3);
  const sent = migration.photos.filter(p => p.filename === 'sent.jpeg');
  assert.equal(sent.length, 1); assert.equal(sent[0].date, '2026-09-01');
  assert.deepEqual(migration.ledger, ['sent.jpeg', 'future.jpeg']);
  assert.deepEqual(await readFile(join(source, 'mitene_uploaded.json')), beforeLedger);
  assert.equal(await readFile(duplicate, 'utf8'), 'synthetic');
  assert.equal(await readFile(sent[0].path, 'utf8'), 'synthetic');
}));

test('same-name legacy photos with differing bytes refuse migration and preserve both originals', async () => temporary(async root => {
  const { source, archive } = await legacyFixture(root);
  await mkdir(join(archive, '2026-09-02'));
  const duplicate = join(archive, '2026-09-02', 'sent.jpeg');
  const beforeLedger = await readFile(join(source, 'mitene_uploaded.json'));
  for(const contents of ['synthetiX', 'a different length']) {
    await writeFile(duplicate, contents);
    await assert.rejects(() => inspectLegacy(source, defaults('/fixture')), /内容が異なる写真.*sent.jpeg.*2026-09-01.*2026-09-02.*バックアップ/);
    assert.equal(await readFile(duplicate, 'utf8'), contents);
    assert.equal(await readFile(join(archive, '2026-09-01', 'sent.jpeg'), 'utf8'), 'synthetic');
    assert.deepEqual(await readFile(join(source, 'mitene_uploaded.json')), beforeLedger);
  }
}));

const fixtureJob: LegacyJob = { label: 'com.codomon-photo-sync.person', path: '/fixture/job.plist', directory: '/fixture', running: false };
function missingJob(): Error { return Object.assign(new Error('missing'), { code: 113, stderr: 'Could not find service in domain' }); }

test('pause refuses stale running jobs after disabling and never boots them out', async () => {
  const commands: string[] = [];
  const runner: LegacyCommandRunner = async (_program, args) => { commands.push(args[0]); return { stdout: args[0] === 'print' ? 'state = running\npid = 1234\n' : '' }; };
  await assert.rejects(() => pauseLegacy([fixtureJob], runner), /処理中/);
  assert.deepEqual(commands, ['disable', 'print']);
});

test('pause verifies unload and tolerates only explicit missing-service results', async () => {
  const commands: string[] = [];
  let prints = 0;
  const runner: LegacyCommandRunner = async (_program, args) => {
    commands.push(args[0]);
    if (args[0] === 'print' && ++prints === 2) throw missingJob();
    return { stdout: 'state = not running\n' };
  };
  await pauseLegacy([fixtureJob], runner);
  assert.deepEqual(commands, ['disable', 'print', 'bootout', 'print']);
  for (const error of [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), Object.assign(new Error('denied'), { code: 1 })]) {
    const fail: LegacyCommandRunner = async (_program, args) => { if (args[0] === 'print') throw error; return { stdout: '' }; };
    await assert.rejects(() => pauseLegacy([fixtureJob], fail), /状態を確認できません/);
  }
});

test('pause refuses an unload that leaves a job loaded and never runs unrelated labels', async () => {
  const runner: LegacyCommandRunner = async () => ({ stdout: 'state = not running\n' });
  await assert.rejects(() => pauseLegacy([fixtureJob], runner), /停止できません/);
  let called = false;
  await assert.rejects(() => pauseLegacy([{ ...fixtureJob, label: 'com.unrelated.agent' }], async () => { called = true; return { stdout: '' }; }), /ジョブ名/);
  assert.equal(called, false);
});

test('malformed legacy session or ledger aborts inspection without changing source', async () => temporary(async root => {
  const { source } = await legacyFixture(root);
  await writeFile(join(source, 'storage_state.json'), JSON.stringify({ cookies: 'not-an-array', origins: [] }));
  await assert.rejects(() => inspectLegacy(source, defaults('/fixture')), /ログイン/);
  await rm(join(source, 'storage_state.json'));
  await writeFile(join(source, 'mitene_uploaded.json'), '{}');
  await assert.rejects(() => inspectLegacy(source, defaults('/fixture')), /送信履歴/);
}));

function syncFixture(store: Store, ranges: string[][]): Service {
  store.saveSettings({ ...store.settings(), importPhotos: false });
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected connector call in acquisition fixture'); };
  const connectors: Connections = {
    manualLogin: unexpected, importIntoPhotos: unexpected, analyzePhotos: unexpected, uploadMitene: unexpected,
    syncCodmon: async (_settings, _session, start, end) => { ranges.push([start, end]); return { photos: [], posts: [], errors: [] }; },
  };
  return new Service(store, { has: () => true, get: () => ({ cookies: [], origins: [] }), put: () => {} }, connectors,
    { changed: () => {}, notify: () => {}, checkLegacy: async () => {} });
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
