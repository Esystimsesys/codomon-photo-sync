import type { ArchivePost as Post } from '../shared/types';

/** One record as shown on screen. */
export interface RecordEntry {
  kind: string;
  title: string;
  author: string;
  text: string;
  fields: [string, string][];
  items: string[];
  attachments: number;
}

const kindLabels: Record<string, string> = {activities:'活動記録',topics:'お知らせ',comments:'連絡帳',bills:'請求'};

export function recordEntry(post: Post): RecordEntry {
  const kind = kindLabels[post.kind] || post.kind;
  const note = contactNote(post.body.trim());
  // Bill records keep only "name amount" lines in the body.
  const items = kind === '請求' && !note ? post.body.split('\n').map(line => money(line.trim())).filter(Boolean) : [];
  return { kind, title: post.title.trim(), author: post.author ?? '', text: note ? note.memo : items.length ? '' : tidy(post.body), fields: note?.fields ?? [], items, attachments: post.attachments.length };
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

/** Archiving turns <br> into line breaks, including those inside the JSON strings of 連絡帳, which JSON.parse rejects. */
function escapeControls(json: string): string {
  let out = '', inString = false, escaped = false;
  for (const c of json) {
    if (inString && !escaped && c < ' ') { out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : ''; continue; }
    if (escaped) escaped = false; else if (c === '\\') escaped = inString; else if (c === '"') inString = !inString;
    out += c;
  }
  return out;
}
