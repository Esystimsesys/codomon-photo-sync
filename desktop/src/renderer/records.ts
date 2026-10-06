import type { ArchivePost as Post } from '../shared/types';

/** One record as shown on screen. A legacy (Python版) day file expands into one entry per post. */
export interface RecordEntry {
  kind: string;
  title: string;
  author: string;
  text: string;
  fields: [string, string][];
  items: string[];
  attachments: number;
}

const kindLabels: Record<string, string> = {activities:'活動記録',topics:'お知らせ',comments:'連絡帳',bills:'請求',timeline:'活動記録',contact:'連絡帳',notice:'お知らせ',bill:'請求',communication:'連絡帳',invoice:'請求',請求情報:'請求'};
const META = /^- (投稿者|公開範囲|配信): /;

export function recordEntries(post: Post): RecordEntry[] {
  const kind = kindLabels[post.kind] || post.kind;
  if (!/^# .+\n/.test(post.body)) return [entry(kind, post.title, '', post.body, [], post.attachments.length)];
  // Legacy archives store a whole Markdown day file: "## [種別] タイトル", meta, body, photos and attachments.
  const out: RecordEntry[] = [];
  for (const section of post.body.split(/^## /m).slice(1)) {
    const [heading, ...lines] = section.split('\n');
    const m = heading.match(/^\[([^\]]*)\]\s*(.*)$/);
    const label = m ? kindLabels[m[1]] || m[1] : kind;
    let author = '', attachments = 0, inPhotos = false;
    const text: string[] = [], items: string[] = [];
    for (const line of lines) {
      if (/^### 写真/.test(line)) { inPhotos = true; continue; }
      if (inPhotos && /^- !\[/.test(line)) continue;
      inPhotos = false;
      if (META.test(line)) { author = line.slice(2).split(' / ').find(p => p.startsWith('投稿者: '))?.slice(5).trim() || author; continue; }
      if (/^- 添付(: |ファイルあり)/.test(line)) { attachments++; continue; }
      if (label === '請求' && /^- /.test(line)) { items.push(line.slice(2).trim()); continue; }
      text.push(line);
    }
    out.push(entry(label, m ? m[2] : heading, author, text.join('\n'), items, attachments));
  }
  return out.length ? out : [entry(kind, post.title, '', post.body, [], post.attachments.length)];
}

function entry(kind: string, title: string, author: string, body: string, items: string[], attachments: number): RecordEntry {
  const note = contactNote(body.trim());
  // New bill records keep only "name amount" lines in the body.
  if (kind === '請求' && !note && !items.length) { items = body.split('\n').map(line => line.trim()).filter(Boolean); body = ''; }
  return { kind, title: title.trim(), author, text: note ? note.memo : tidy(body), fields: note?.fields ?? [], items: items.map(money).filter(Boolean), attachments };
}

const tidy = (text: string) => text.replace(/[ \t　]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
const money = (text: string) => text.replace(/(^|\s)(\d+)$/, (_, space: string, n: string) => `${space}${Number(n).toLocaleString('ja-JP')}円`).trim();
const list = (value: unknown) => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Record<string, unknown>[] : [];
const time = (value: unknown) => String(value ?? '').replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');

/** 連絡帳 bodies are a JSON object (memo, meal, temperatures…). Unknown keys are kept rather than dropped. */
function contactNote(body: string): { memo: string; fields: [string, string][] } | null {
  if (!body.startsWith('{')) return null;
  let data: unknown;
  try { data = JSON.parse(escapeControls(body)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const fields: [string, string][] = [];
  const add = (label: string, value: string) => { if (value.trim()) fields.push([label, tidy(value)]); };
  add('機嫌', [d.mood_morning && `朝 ${d.mood_morning}`, d.mood_afternoon && `午後 ${d.mood_afternoon}`].filter(Boolean).join('　'));
  add('体温', list(d.tempratures).map(t => `${time(t.temprature_time)} ${t.temprature ?? ''}℃`.trim()).join('　'));
  add('食事', String(d.meal ?? ''));
  add('睡眠', String(d.sleepings ?? ''));
  add('排便', list(d.evacuations).map(e => `${time(e.evacuation_time)} ${e.evacuation ?? ''}`.trim()).join('　'));
  add('入浴', String(d.bathing ?? ''));
  const known = new Set(['memo','memo_html','mood_morning','mood_afternoon','tempratures','meal','sleepings','evacuations','bathing']);
  for (const [key, value] of Object.entries(d)) if (!known.has(key) && (typeof value === 'string' || typeof value === 'number')) add(key, String(value));
  return { memo: tidy(String(d.memo ?? '')), fields };
}

/** The legacy version turned <br> into raw line breaks even inside JSON strings, which JSON.parse rejects. */
function escapeControls(json: string): string {
  let out = '', inString = false, escaped = false;
  for (const c of json) {
    if (inString && !escaped && c < ' ') { out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : ''; continue; }
    if (escaped) escaped = false; else if (c === '\\') escaped = inString; else if (c === '"') inString = !inString;
    out += c;
  }
  return out;
}
