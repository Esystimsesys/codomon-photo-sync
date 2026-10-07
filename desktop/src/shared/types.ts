export type SendMode = 'review' | 'automatic';
export type Decision = 'auto' | 'include' | 'exclude';
export type UploadState = 'pending' | 'sending' | 'sent' | 'uncertain' | 'skipped';
export interface Settings {
  saveRoot: string;
  album: string;
  /** Macの「写真」アプリの「ピープル」の名前と、その子の写真をまとめるアルバム名（空なら「取り込み先（名前）」）。きょうだいは並べて登録する。 */
  people: Person[];
  photosLibrary: string;
  importPhotos: boolean;
  sendMode: SendMode;
  miteneEnabled: boolean;
  miteneScope: '家族みんなに公開' | '管理者のみ';
  autoSync: boolean;
  syncTimes: string[];
  faceTimes: string[];
  launchAtLogin: boolean;
  initialStartDate: string;
  faceMinPx: number;
  faceMinRatio: number;
  faceMainRatio: number;
  faceMaxPeople: number;
  setupComplete: boolean;
}
export interface Person { name: string; album: string; }
export interface ArchivePhoto { id: string; filename: string; path: string; date: string; title: string; postId: string; }
export interface Photo extends ArchivePhoto {
  decision: Decision; autoSelected: boolean; reason: string; uploadState: UploadState;
  imported: boolean; importError: string | null; sentAt: string | null;
}
export interface ArchivePost { id: string; date: string; kind: string; title: string; body: string; path: string; attachments: string[]; author?: string; children?: string[]; }
export interface SyncResult { photos: ArchivePhoto[]; posts: ArchivePost[]; errors: string[]; }
export interface FaceResult { filename: string; person: string; selected: boolean; reason: string; }
export interface Job { id: number; kind: string; startedAt: string; endedAt: string | null; status: 'running' | 'success' | 'error'; message: string; }
export interface Snapshot {
  settings: Settings; photos: Photo[]; posts: ArchivePost[]; jobs: Job[];
  busy: boolean; progress: string; codmonConnected: boolean; miteneConnected: boolean;
  platform: string; demo: boolean; validation?: boolean; update: { version: string; url: string } | null;
}
export type Action =
  | { type: 'settings'; settings: Settings }
  | { type: 'login'; provider: 'codmon' | 'mitene' }
  | { type: 'sync'; startDate?: string; endDate?: string }
  | { type: 'analyze' }
  | { type: 'decision'; ids: string[]; decision: Decision }
  | { type: 'send'; ids: string[] }
  | { type: 'resolve'; ids: string[]; resolution: 'sent' | 'retry' | 'skipped' }
  | { type: 'seed'; ids: string[] }
  | { type: 'chooseFolder' }
  | { type: 'chooseLibrary' }
  | { type: 'openArchive' }
  | { type: 'openPost'; id: string }
  | { type: 'openPrivacy' }
  | { type: 'checkUpdate' }
  | { type: 'openUpdate' };
export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  action(action: Action): Promise<Snapshot | { path: string } | null>;
  onChange(callback: (snapshot: Snapshot) => void): () => void;
}
declare global { interface Window { desktop: DesktopApi; } }
