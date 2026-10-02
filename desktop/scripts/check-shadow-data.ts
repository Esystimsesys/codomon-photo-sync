/**
 * Isolated, read-only-against-legacy migration and acquisition check.
 * Run with tsx. This script never opens Photos, submits to Mitene, persists sessions,
 * or disables old jobs. Only the explicitly chosen empty output directory is written.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { inspectLegacy, legacyJobs, type LegacyJob } from '../src/main/migration';
import { Store, defaults, validDay, validateSettings } from '../src/main/store';
import { syncCodmon, refreshMiteneSession, type Session } from '../src/main/connectors';
import type { ArchivePhoto, ArchivePost, Settings } from '../src/shared/types';

export interface ShadowOptions {
  source: string;
  output: string;
  sync?: boolean;
  refreshMitene?: boolean;
  browserPath?: string;
}
interface FileSnapshot { relative: string; bytes: number; sha256: string; }
interface Summary {
  success: boolean;
  stage: string;
  failure?: string;
  retryWithNewOutput?: boolean;
  counts: Record<string, number>;
  checks: Record<string, boolean>;
}
class CheckFailure extends Error { constructor(readonly code: string) { super(code); } }
function requireCheck(condition: unknown, code: string): asserts condition { if (!condition) throw new CheckFailure(code); }
function isWithin(file: string, root: string): boolean {
  const r = relative(root, file);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
function overlaps(a: string, b: string): boolean { return isWithin(a, b) || isWithin(b, a); }
async function noLink(filename: string, directory = false): Promise<void> {
  const info = await lstat(filename);
  requireCheck(!info.isSymbolicLink(), 'symlink-rejected');
  requireCheck(directory ? info.isDirectory() : info.isFile(), 'unexpected-file-type');
}
async function hashFile(filename: string): Promise<{ bytes: number; sha256: string }> {
  await noLink(filename);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    return { bytes, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}
async function inventory(root: string, folder = root): Promise<FileSnapshot[]> {
  await noLink(folder, true);
  const files: FileSnapshot[] = [];
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(folder, entry.name);
    requireCheck(!entry.isSymbolicLink(), 'symlink-rejected');
    if (entry.isDirectory()) files.push(...await inventory(root, p));
    else {
      requireCheck(entry.isFile(), 'unexpected-file-type');
      requireCheck(isWithin(await realpath(p), root), 'source-path-escaped');
      files.push({ relative: relative(root, p), ...await hashFile(p) });
    }
  }
  return files;
}
const controlNames = ['config.json', 'mitene_uploaded.json', 'storage_state.json', 'mitene_state.json'];
async function controls(source: string): Promise<FileSnapshot[]> {
  const entries: FileSnapshot[] = [];
  for (const name of controlNames) {
    try { entries.push({ relative: name, ...await hashFile(join(source, name)) }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  requireCheck(entries.some(e => e.relative === 'config.json'), 'missing-legacy-config');
  return entries;
}
function inventoryEqual(a: FileSnapshot[], b: FileSnapshot[]): boolean {
  const project = (rows: FileSnapshot[]) => rows.map(r => `${r.relative}\0${r.bytes}\0${r.sha256}`).sort();
  return JSON.stringify(project(a)) === JSON.stringify(project(b));
}
function archivedDay(file: FileSnapshot): boolean {
  const day = file.relative.split(sep)[0];
  return validDay(day) || day === 'unknown-date';
}
function independentPhotos(files: FileSnapshot[]): Map<string, FileSnapshot> {
  const result = new Map<string, FileSnapshot>();
  for (const file of files.filter(archivedDay)) {
    const pieces = file.relative.split(sep);
    if (pieces.length !== 2 || !['.jpeg', '.jpg', '.png'].includes(extname(pieces[1]).toLowerCase())) continue;
    const existing = result.get(pieces[1]);
    requireCheck(!existing || existing.sha256 === file.sha256, 'conflicting-legacy-photo-name');
    if (!existing) result.set(pieces[1], file);
  }
  return result;
}
async function independentLedger(source: string): Promise<Set<string>> {
  let value: unknown;
  try { await noLink(join(source, 'mitene_uploaded.json')); value = JSON.parse(await readFile(join(source, 'mitene_uploaded.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  requireCheck(Array.isArray(value), 'invalid-legacy-ledger');
  requireCheck(value.every(v => typeof v === 'string' && v.length > 0 && basename(v) === v && !v.includes('\0')), 'invalid-legacy-ledger');
  return new Set(value);
}
async function copyVerified(source: string, destination: string, expected: FileSnapshot, sourceRoot: string): Promise<void> {
  requireCheck(isWithin(await realpath(source), sourceRoot), 'source-path-escaped');
  await noLink(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(destination, 'wx', 0o600);
    try {
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of input.createReadStream({ autoClose: false })) { await output.writeFile(chunk); bytes += chunk.length; hash.update(chunk); }
      await output.sync();
      requireCheck(bytes === expected.bytes && hash.digest('hex') === expected.sha256, 'source-changed-during-copy');
    } finally { await output.close(); }
  } finally { await input.close(); }
  const copied = await hashFile(destination);
  requireCheck(copied.bytes === expected.bytes && copied.sha256 === expected.sha256, 'copy-verification-failed');
}
function safeSettings(settings: Settings, archive: string): Settings {
  return validateSettings({ ...settings, saveRoot: archive, sendMode: 'review', autoSync: false,
    launchAtLogin: false, importPhotos: false, miteneEnabled: false, setupComplete: true });
}
function verifyStore(store: Store, expected: Map<string, FileSnapshot>, ledger: Set<string>, archive: string, exact = true): void {
  const photos = store.photos();
  requireCheck(new Set(photos.map(p => p.id)).size === photos.length, 'duplicate-photo-identities');
  requireCheck(new Set(photos.map(p => p.filename)).size === photos.length, 'duplicate-photo-filenames');
  if (exact) requireCheck(photos.length === expected.size, 'migration-photo-count-mismatch');
  for (const [filename, old] of expected) {
    const p = store.photo(filename);
    requireCheck(p && p.filename === filename && isWithin(p.path, archive), 'migration-photo-missing');
    if (exact) requireCheck(p.path === join(archive, old.relative), 'migration-photo-path-mismatch');
    requireCheck(!ledger.has(filename) || p.uploadState === 'sent', 'legacy-sent-became-unsent');
    if (exact && !ledger.has(filename)) requireCheck(p.uploadState === 'pending', 'legacy-pending-state-mismatch');
  }
  const persisted = store.db.prepare('SELECT filename,state FROM ledger').all();
  requireCheck(persisted.length === ledger.size && persisted.every(row => ledger.has(String(row.filename)) && row.state === 'sent'), 'ledger-identity-mismatch');
  const s = store.settings();
  requireCheck(s.sendMode === 'review' && !s.autoSync && !s.launchAtLogin && !s.importPhotos && !s.miteneEnabled && s.saveRoot === archive, 'unsafe-shadow-settings');
}
function storeProjection(store: Store): string {
  return JSON.stringify({ photos: store.photos(), posts: store.posts(), ledger: store.db.prepare('SELECT * FROM ledger ORDER BY filename').all(), settings: store.settings() });
}
function identitySet(items: { id: string }[]): string { return JSON.stringify(items.map(p => p.id).sort()); }
function lastSevenDays(): [string, string] {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date(), start = new Date(end); start.setDate(start.getDate() - 6);
  return [day(start), day(end)];
}

/** jobs adapter exists solely for synthetic verification; CLI always uses read-only legacyJobs. */
export async function runShadowCheck(options: ShadowOptions, adapters: { jobs?: (source: string) => Promise<LegacyJob[]> } = {}): Promise<Summary> {
  const report: Summary = { success: false, stage: 'validate', counts: {}, checks: {} };
  let output: string | undefined, store: Store | undefined;
  try {
    requireCheck(!!options.source && !!options.output, 'source-and-output-required');
    const sourceInput = resolve(options.source);
    await noLink(sourceInput, true);
    const source = await realpath(sourceInput);
    const beforeControls = await controls(source);
    const config = JSON.parse(await readFile(join(source, 'config.json'), 'utf8'));
    const configuredRoot = typeof config?.save_root === 'string' ? config.save_root : '~/Pictures/codomon';
    const originalRoot = configuredRoot.startsWith('~/') ? join(homedir(), configuredRoot.slice(2)) : resolve(configuredRoot);
    await noLink(originalRoot, true);
    const archiveRoot = await realpath(originalRoot);
    const requestedOutput = resolve(options.output);
    const candidate = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
    requireCheck(!overlaps(candidate, source) && !overlaps(candidate, archiveRoot), 'output-overlaps-source');
    try { await noLink(candidate, true); requireCheck((await readdir(candidate)).length === 0, 'output-not-empty'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(candidate, { mode: 0o700 }); }
    await chmod(candidate, 0o700); output = candidate;
    const archive = join(output, 'archive'); await mkdir(archive, { mode: 0o700 });
    report.stage = 'source-snapshot';
    const beforeFiles = await inventory(archiveRoot);
    const expectedPhotos = independentPhotos(beforeFiles);
    const expectedLedger = await independentLedger(source);
    const jobs = adapters.jobs ?? legacyJobs;
    const beforeJobs = await jobs(source);
    report.counts.legacyJobs = beforeJobs.length;
    report.counts.legacyRunningJobs = beforeJobs.filter(j => j.running).length;
    const migration = await inspectLegacy(source, defaults());
    requireCheck(migration.settings.saveRoot === archiveRoot, 'legacy-root-changed');
    requireCheck(migration.photos.length === expectedPhotos.size, 'inspection-photo-count-mismatch');
    requireCheck(migration.ledger.length === expectedLedger.size && migration.ledger.every(n => expectedLedger.has(n)), 'inspection-ledger-mismatch');
    for (const p of migration.photos) requireCheck(p.id === p.filename && p.path === join(archiveRoot, expectedPhotos.get(p.filename)?.relative ?? ''), 'inspection-photo-identity-mismatch');
    report.stage = 'copy';
    const archivedFiles = beforeFiles.filter(archivedDay);
    for (const file of archivedFiles) await copyVerified(join(archiveRoot, file.relative), join(archive, file.relative), file, archiveRoot);
    const copiedFiles = await inventory(archive);
    requireCheck(inventoryEqual(archivedFiles, copiedFiles), 'copied-inventory-mismatch');
    const photos: ArchivePhoto[] = migration.photos.map(p => ({ ...p, path: join(archive, relative(archiveRoot, p.path)) }));
    const posts: ArchivePost[] = migration.posts.map(p => {
      const record = beforeFiles.find(f => join(archiveRoot, f.relative) === p.path);
      requireCheck(record, 'legacy-record-file-missing');
      const attachments = archivedFiles.filter(f => f.relative.startsWith(`${p.date}${sep}添付${sep}`)).map(f => join(archive, f.relative));
      return { ...p, path: join(archive, record.relative), attachments };
    });
    report.counts.copiedFiles = copiedFiles.length;
    report.counts.copiedBytes = copiedFiles.reduce((n, f) => n + f.bytes, 0);
    report.counts.sourcePhotoFiles = archivedFiles.filter(f => f.relative.split(sep).length === 2 && ['.jpeg', '.jpg', '.png'].includes(extname(f.relative).toLowerCase())).length;
    report.counts.uniquePhotos = photos.length;
    report.counts.identicalDuplicatePhotos = report.counts.sourcePhotoFiles - photos.length;
    report.counts.posts = posts.length;
    report.counts.ledgerEntries = expectedLedger.size;
    report.counts.legacySentPhotos = photos.filter(p => expectedLedger.has(p.filename)).length;
    report.stage = 'migration-replay';
    store = new Store(join(output, 'archive.sqlite'));
    const settings = safeSettings(migration.settings, archive);
    const apply = () => store!.transaction(() => { store!.saveSettings(settings); store!.seedFilenames(migration.ledger); store!.upsertPhotos(photos); store!.upsertPosts(posts); });
    apply(); verifyStore(store, expectedPhotos, expectedLedger, archive);
    const firstProjection = storeProjection(store);
    apply(); verifyStore(store, expectedPhotos, expectedLedger, archive);
    requireCheck(storeProjection(store) === firstProjection, 'migration-replay-changed-data');
    report.checks.copyVerified = true; report.checks.migrationReplayStable = true; report.checks.legacySentPreserved = true;
    // Session objects remain in memory. No session callbacks write them to files or the output DB.
    if (options.sync) {
      report.stage = 'codmon-repeated-acquisition';
      requireCheck(migration.sessions.codmon, 'codmon-session-missing');
      let session = migration.sessions.codmon as Session;
      const [start, end] = lastSevenDays();
      const connectorOptions = { executablePath: options.browserPath, onSession: (value: Session) => { session = value; } };
      const first = await syncCodmon(settings, session, start, end, connectorOptions);
      report.counts.firstSyncErrors = first.errors.length;
      requireCheck(first.errors.length === 0, 'codmon-first-sync-errors');
      requireCheck(new Set(first.photos.map(p => p.id)).size === first.photos.length && new Set(first.posts.map(p => p.id)).size === first.posts.length, 'duplicate-acquisition-identities');
      store.ingest(first.photos, first.posts); verifyStore(store, expectedPhotos, expectedLedger, archive, false);
      const afterFirstPhotos = store.photos().length, afterFirstPosts = store.posts().length;
      const second = await syncCodmon(settings, session, start, end, connectorOptions);
      report.counts.secondSyncErrors = second.errors.length;
      requireCheck(second.errors.length === 0, 'codmon-second-sync-errors');
      requireCheck(identitySet(first.photos) === identitySet(second.photos) && identitySet(first.posts) === identitySet(second.posts), 'acquisition-source-changed-retry');
      store.ingest(second.photos, second.posts); verifyStore(store, expectedPhotos, expectedLedger, archive, false);
      requireCheck(store.photos().length === afterFirstPhotos && store.posts().length === afterFirstPosts, 'repeated-acquisition-duplicated-records');
      report.counts.acquiredPhotos = second.photos.length; report.counts.acquiredPosts = second.posts.length;
      report.checks.repeatedAcquisitionStable = true;
    }
    if (options.refreshMitene) {
      report.stage = 'mitene-read-only-refresh';
      requireCheck(migration.sessions.mitene, 'mitene-session-missing');
      await refreshMiteneSession(migration.sessions.mitene as Session, { executablePath: options.browserPath });
      report.checks.miteneReadOnlyRefresh = true;
    }
    report.stage = 'source-unchanged';
    const afterJobs = await jobs(source), afterControls = await controls(source), afterFiles = await inventory(archiveRoot);
    requireCheck(inventoryEqual(beforeControls, afterControls) && inventoryEqual(beforeFiles, afterFiles), 'source-changed-retry');
    const jobConfig = (rows: LegacyJob[]) => JSON.stringify(rows.map(j => `${j.label}\0${j.path}\0${j.directory}`).sort());
    requireCheck(jobConfig(beforeJobs) === jobConfig(afterJobs), 'legacy-job-registration-changed-retry');
    report.counts.legacyRunningJobsAfter = afterJobs.filter(j => j.running).length;
    report.counts.finalPhotos = store.photos().length; report.counts.finalPosts = store.posts().length;
    report.checks.sourceUnchanged = true; report.checks.legacyJobRegistrationUnchanged = true; report.checks.safeShadowSettings = true;
    // Ensure the packaged test-mode app sees the complete standalone database after this process exits.
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); store.close(); store = undefined;
    report.success = true; report.stage = 'complete';
  } catch (error) {
    report.failure = error instanceof CheckFailure ? error.code : 'check-operation-failed';
    report.retryWithNewOutput = true;
  } finally {
    store?.close();
    if (output) {
      await writeFile(join(output, 'shadow-check-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      if (report.success) await writeFile(join(output, 'shadow-verification.json'), JSON.stringify({ format: 'omukae-shadow-v1', status: 'passed', counts: report.counts, checks: report.checks }, null, 2), { mode: 0o600, flag: 'wx' });
    }
  }
  return report;
}

function parseOptions(args: string[]): ShadowOptions {
  const options: ShadowOptions = { source: process.env.CODOMON_SHADOW_SOURCE || '', output: process.env.CODOMON_SHADOW_OUTPUT || '', browserPath: process.env.CODOMON_SHADOW_BROWSER };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sync') options.sync = true;
    else if (args[i] === '--refresh-mitene') options.refreshMitene = true;
    else if (['--source', '--output', '--browser-path'].includes(args[i])) {
      const key = args[i] === '--source' ? 'source' : args[i] === '--output' ? 'output' : 'browserPath';
      requireCheck(!!args[i + 1] && !args[i + 1].startsWith('--'), 'missing-option-value'); options[key] = args[++i];
    } else throw new CheckFailure('unknown-option');
  }
  requireCheck(!!options.source && !!options.output, 'source-and-output-required');
  return options;
}
async function cli(): Promise<void> {
  process.umask(0o077);
  try {
    const summary = await runShadowCheck(parseOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (!summary.success) process.exitCode = 1;
  } catch (error) {
    // Never print arbitrary errors: Playwright/filesystem messages may contain personal paths or URL tokens.
    process.stdout.write(`${JSON.stringify({ success: false, stage: 'validate', failure: error instanceof CheckFailure ? error.code : 'check-operation-failed' })}\n`);
    process.exitCode = 1;
  }
}

if (typeof require !== 'undefined' && require.main === module) void cli();
