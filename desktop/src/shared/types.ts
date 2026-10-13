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
  /** 自動送信をオンにした日（YYYY-MM-DD）。この日より前にコドモンに届いた写真は自動では送らない。オフなら空。 */
  autoSendFrom: string;
}
export interface Person { name: string; album: string; }
export interface ArchivePhoto {
  id: string; filename: string; path: string; date: string; title: string; postId: string;
  /** コドモンで保護者に届いた日（YYYY-MM-DD）。`date` は園が付けた表示日で、さかのぼることがある。分からなければ空。 */
  postedDate?: string;
}
export interface Photo extends ArchivePhoto {
  decision: Decision; autoSelected: boolean; reason: string; uploadState: UploadState;
  imported: boolean; importError: string | null; sentAt: string | null;
}
/**
 * お知らせに付いた動画。コドモンで変換が済んだものは保存し、写真と同じく「写真」アプリ・顔認識・みてねの対象にする
 * （写真の一覧には `.mp4` のファイルとして入る）。ここには記録に添える情報を持つ。
 */
export interface ArchiveVideo {
  name: string;
  /** バイト数。分からなければ0。 */
  size: number;
  /** 再生期限（コドモンの日時の文字列、日本時間）。なければ空。 */
  expires: string;
  /** 保存した動画のパス。変換前・期限切れで保存できなかったときはない。 */
  path?: string;
}
export interface ArchivePost { id: string; date: string; kind: string; title: string; body: string; path: string; attachments: string[]; author?: string; children?: string[]; videos?: ArchiveVideo[]; }
export interface SyncResult { photos: ArchivePhoto[]; posts: ArchivePost[]; errors: string[]; }
export interface FaceResult { filename: string; person: string; selected: boolean; reason: string; }
export interface Job { id: number; kind: string; startedAt: string; endedAt: string | null; status: 'running' | 'success' | 'error'; message: string; }
export interface Snapshot {
  settings: Settings; photos: Photo[]; posts: ArchivePost[]; jobs: Job[];
  busy: boolean; progress: string; codmonConnected: boolean; miteneConnected: boolean;
  platform: string; demo: boolean;
  /** このアプリのバージョン（package.json の version）。 */
  version: string; validation?: boolean; update: { version: string; url: string } | null;
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
  | { type: 'openVideo'; id: string }
  | { type: 'openPrivacy' }
  | { type: 'checkUpdate' }
  | { type: 'openUpdate' }
  | { type: 'exportTransfer' }
  | { type: 'importTransfer' };
/** 使うMacを変えるときに引き継ぐもの。ログイン情報はMacのキーチェーンで暗号化されているので含めない。 */
export interface TransferFile {
  format: 'omukae-photo-transfer'; version: 1; exportedAt: string; appVersion: string;
  settings: Settings;
  /** みてねに送った（または送らないことにした）写真。ファイル名で照合する。 */
  ledger: { filename: string; state: 'sent' | 'skipped'; at: string }[];
  /** 手動で選んだ・外した写真。 */
  decisions: { filename: string; decision: 'include' | 'exclude' }[];
}
export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  action(action: Action): Promise<Snapshot | { path: string } | { message: string } | null>;
  onChange(callback: (snapshot: Snapshot) => void): () => void;
}
declare global { interface Window { desktop: DesktopApi; } }
