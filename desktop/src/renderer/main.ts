import type { Action, DesktopApi, Job, Person, Photo, Settings, Snapshot } from '../shared/types';
import { createDemo, demoImage } from './demo';
import './style.css';
import { icon, type IconName } from './icons';
import { recordEntry, type RecordEntry } from './records';
import { beforeAutoSend } from '../shared/send';
const brandIcon = new URL('../../build/icon.svg', import.meta.url).href;
const browserDemo = !window.desktop;
const api: DesktopApi = window.desktop ?? createDemo();
const app = document.querySelector<HTMLDivElement>('#app')!;
let state: Snapshot;
let page: 'overview' | 'photos' | 'records' | 'settings' = 'overview';
// 空なら、その設定の最初のタブを開く。
let filter = '';
let selected = new Set<string>();
let working = false;
let notice = '';
let error = '';
let setup = false;
let recordChild = '';
// Rows typed into the settings form survive a re-render even before they are saved.
let draftPeople: Person[] | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveQueue: Promise<void> = Promise.resolve();
let saveRevision = 0;
let saveState: 'saved' | 'saving' | 'unsaved' = 'saved';
let saveError = '';
let settingsDraft: FormData | null = null;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const candidate = (p: Photo) => p.decision === 'include' || (p.decision === 'auto' && p.autoSelected);
const available = (p: Photo) => p.uploadState === 'pending' && p.decision !== 'exclude';
// 自動送信をオンにした日より前に届いた、未送信の送る写真。自動では送らないので、見てから手動で送る。
const older = (p: Photo) => available(p) && candidate(p) && beforeAutoSend(p, state.settings);
const monthDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${Number(v.slice(5, 7))}月${Number(v.slice(8))}日` : v;
const disabled = () => working || state.busy ? 'disabled' : '';
// 候補 = みてねへ送る・子どものアルバムに入れる写真。顔認識もみてねも使わないなら選別の画面は出さない。
const usesSelection = () => state.settings.miteneEnabled || !!state.settings.people.length;
const label: Record<string,string> = {pending:'未送信', sending:'送信中', sent:'送信済み', uncertain:'要確認', skipped:'送らない'};
const date = (v: string | null | undefined) => v ? new Intl.DateTimeFormat('ja-JP', {month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(v)) : '';
const day = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Intl.DateTimeFormat('ja-JP', {year:'numeric', month:'long', day:'numeric', weekday:'short'}).format(new Date(`${v}T00:00:00`)) : v === 'unknown-date' ? '日付不明' : v;
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
function lastSync(): string { const job = state.jobs.find(j => j.status === 'success' && j.kind === '写真・記録を取得'); return job ? date(job.endedAt || job.startedAt) : ''; }
// 選択中で未送信の写真の呼び方。確認してから送るなら「候補」、自動で送るなら次の同期を待つだけの「送信待ち」。
function queueName(): string { const s = state.settings; return !s.miteneEnabled ? 'まとめる写真' : s.sendMode === 'automatic' ? '送信待ち' : '送る候補'; }
// 顔認識の判定は保存用の短い文で残っているので、画面では子どもの名前を使った文に言い換える。
function faceText(raw: string, name: string): string {
 if(raw === '対象の人物が見つかりません') return `${name}は写っていないようです`;
 if(raw === '顔認識で候補になりました') return `${name}が写っています`;
 if(raw === '顔認識の結果待ち') return '顔認識の結果を待っています';
 if(raw.startsWith('顔が検出されていません')) return `${name}の顔がはっきり写っていません`;
 if(raw.startsWith('顔が小さめです')) return `${name}の顔が小さく写っています`;
 if(raw.startsWith('ほかの人が大きく写っています')) return `${name}より、ほかの人が大きく写っています`;
 return raw;
}
// 写っていると判定された子ども。判定は store.applyFaces が理由の文にまとめているので、そこから読み取る。
function presentChildren(p: Photo): string[] {
 const people = state.settings.people.map(c => c.name);
 if(!p.autoSelected || !people.length) return [];
 if(people.length === 1) return people;
 const list = p.reason.endsWith('が写っています') ? `・${p.reason.slice(0, -'が写っています'.length)}・` : '';
 return people.filter(name => list.includes(`・${name}・`));
}
function reasonText(p: Photo): string {
 const people = state.settings.people;
 if(p.decision === 'include') return '手動で選択しました';
 if(p.decision === 'exclude') return '手動で外しました';
 if(!people.length) return '';
 if(people.length === 1) return faceText(p.reason, people[0].name);
 if(p.reason === '対象の人物が見つかりません') return '登録した子どもは写っていないようです';
 // きょうだいのときは「名前：判定 / 名前：判定」の形で残っている。
 if(p.reason.includes('：')) return p.reason.split(' / ').map(part => { const [name, raw] = part.split('：'); return faceText(raw ?? '', name); }).join('。');
 return faceText(p.reason, '子ども');
}
function photoURL(photo: Photo, index: number) { return browserDemo || state.demo ? demoImage(index) : `codomon-photo://photo/${encodeURIComponent(photo.id)}`; }
function nav(id: typeof page, name: IconName, text: string) { return `<button class="nav ${page === id ? 'active' : ''}" data-page="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(name)}${text}</button>`; }
function render() {
 const oldForm = document.querySelector<HTMLFormElement>('#settings-form');
 const draft = oldForm ? new FormData(oldForm) : settingsDraft;
 draftPeople = draft ? formPeople(draft, true) : null;
 const inSetup = setup || !state.settings.setupComplete;
 const pending = state.photos.filter(p => available(p) && candidate(p) && !beforeAutoSend(p, state.settings));
 const last = lastSync();
 app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#" aria-label="おむかえフォト ホーム"><img class="brand-mark" src="${brandIcon}" alt="" width="44" height="44"><span>おむかえフォト</span></a>${inSetup ? '' : `<nav aria-label="メインメニュー">${nav('overview','home','ホーム')}${nav('photos','photos','写真')}${nav('records','records','園の記録')}${nav('settings','settings','設定')}</nav>`}${inSetup ? '' : `<div class="sidebar-bottom"><span class="status-dot ${state.settings.autoSync ? '' : 'off'}"></span>${state.settings.autoSync ? '自動同期オン' : '自動同期オフ'}<small>ウィンドウを閉じても、バックグラウンドで動き続けます。</small>${state.version ? `<small class="app-version">バージョン ${escape(state.version)}</small>` : ''}</div>`}</aside><main><header class="topbar"><span>${inSetup ? 'はじめの設定' : `前回の同期：${last || 'まだありません'}`}</span><button class="button small" data-action="openArchive">保存先を開く ${icon('external')}</button></header>${browserDemo || state.demo ? '<div class="demo-banner">体験用のデモです。写真と記録は架空のもので、コドモン・みてねには接続しません。</div>' : state.validation ? '<div class="demo-banner validation-banner">動作確認用です。この画面から外部サービスへの接続やMacの「写真」アプリの変更は行いません。</div>' : ''}<div class="alerts">${error ? `<div class="alert error" role="alert"><span>${escape(error)}</span><button class="text-button" data-dismiss="error">閉じる</button></div>` : ''}${notice ? `<div class="alert success" role="status"><span>${escape(notice)}</span><button class="text-button" data-dismiss="notice">閉じる</button></div>` : ''}${state.busy || working ? `<div class="alert progress" role="status"><span class="spinner"></span>${escape(state.progress || '処理しています…')}</div>` : ''}</div><div class="content">${inSetup ? settingsView(true) : page === 'overview' ? overview(pending, last) : page === 'photos' ? photosView() : page === 'records' ? recordsView() : settingsView(false)}</div></main></div><dialog id="confirm-dialog" aria-labelledby="confirm-title"></dialog><dialog id="photo-dialog" class="photo-dialog" aria-labelledby="photo-title"></dialog>`;
 bind();
 const newForm = document.querySelector<HTMLFormElement>('#settings-form');
 if(draft && newForm) restoreForm(newForm, draft);
 if(newForm) syncShown(newForm);
}
function historyTitle(kind: string): string {
 return ({
  '写真・記録を取得': '同期',
  '候補を更新': '顔認識の更新',
  'みてねへ送信': 'みてねへの写真の送信',
  'コドモンにログイン': 'コドモンへのログイン',
  'みてねにログイン': 'みてねへのログイン',
 } as Record<string, string>)[kind] ?? kind;
}
function historyMessage(message: string): string {
 return message.replace('候補を更新しました', '顔認識を更新しました').replace('「写真」アプリの顔認識を反映しました', '顔認識を更新しました')
  .replace('送信対象はありません', 'みてねに送る写真はありません')
  .replace('みてねに送る未送信の写真はありません', 'みてねに送る写真はありません');
}
function overview(pending: Photo[], last: string) {
 const s = state.settings;
 const uncertain = state.photos.filter(p => p.uploadState === 'uncertain').length;
 const olderCount = state.photos.filter(older).length;
 const status = !state.codmonConnected ? 'コドモンへのログインが必要です' : state.photos.length ? `写真${state.photos.length}枚と記録${state.posts.length}件を保存しています` : 'まだ写真を取り込んでいません';
 return `<div class="heading"><div><h1>ホーム</h1></div><button class="button primary" data-action="sync" ${disabled() || (!state.codmonConnected ? 'disabled' : '')}>${icon('sync')} 今すぐ同期</button></div>${state.update ? `<div class="alert success"><div><strong>新しいバージョン ${escape(state.update.version)} があります</strong><p>${state.version ? `お使いのバージョンは ${escape(state.version)} です。` : ''}ダウンロードしたアプリを「アプリケーション」フォルダで置き換えると更新できます。写真・記録・設定はそのまま引き継がれます。</p></div><button class="button" data-action="openUpdate">ダウンロードページを開く ↗</button></div>` : ''}<section class="hero-card"><div><span class="pill ${state.codmonConnected ? '' : 'warning-pill'}">${state.codmonConnected ? 'コドモン：ログイン済み' : 'コドモン：ログインが必要'}</span><h2>${status}</h2><dl class="facts"><div><dt>前回の同期</dt><dd>${last || 'まだありません'}</dd></div><div><dt>自動同期</dt><dd>${s.autoSync ? 'オン' : 'オフ'}</dd></div>${s.miteneEnabled ? `<div><dt>みてねへの送信</dt><dd>${s.sendMode === 'automatic' ? '自動で送る' : '確認してから送る'}${state.miteneConnected ? '' : '（ログインが必要）'}</dd></div>` : ''}</dl><div class="hero-actions">${!state.codmonConnected ? '<button class="button primary" data-login="codmon">コドモンにログイン</button>' : state.photos.length ? '<button class="button" data-page="photos">写真を見る →</button>' : ''}</div></div><div class="hero-art" aria-hidden="true"><img src="${brandIcon}" alt="" width="176" height="176"></div></section><section class="stats" aria-label="保存の状況"><button class="stat" data-page="photos" data-filter="all"><strong>${state.photos.length}<small>枚</small></strong><span>保存した写真</span></button>${usesSelection() ? `<button class="stat" data-page="photos" data-filter="candidates"><strong>${pending.length}<small>枚</small></strong><span>${queueName()}</span></button>` : ''}<button class="stat" data-page="records"><strong>${state.posts.length}<small>件</small></strong><span>園の記録</span></button></section>${olderCount ? `<div class="alert info"><div><strong>みてね自動送信設定前の写真が${olderCount}枚、まだ送られていません</strong><p>${monthDay(s.autoSendFrom)}より前にコドモンに届いた、選択中の写真です。自動では送らないので、見てから送ってください。</p></div><button class="button" data-page="photos" data-filter="older">一覧を見る →</button></div>` : ''}${uncertain ? `<div class="alert warning"><div><strong>送信できたか確認が必要な写真が${uncertain}枚あります</strong><p>みてねに届いているかを確かめて、結果を選んでください。</p></div><button class="button" data-page="photos" data-filter="uncertain">確認する →</button></div>` : ''}<div class="section-heading"><h2>最近の写真</h2>${state.photos.length ? '<button class="text-button" data-page="photos" data-filter="all">すべて見る →</button>' : ''}</div>${state.photos.length ? `<div class="recent-grid">${state.photos.slice(0, 4).map((p, i) => `<button class="recent-photo" data-preview="${escape(p.id)}" aria-label="${escape(p.title || p.filename)}を大きく見る"><img src="${photoURL(p, i)}" alt="" loading="lazy"><span>${escape(day(p.date))}<strong>${escape(p.title || p.filename)}</strong></span></button>`).join('')}</div>` : empty('まだ写真がありません', state.codmonConnected ? '「今すぐ同期」を押すと、コドモンの写真がここに表示されます。' : 'コドモンにログインして同期すると、写真がここに表示されます。')}<div class="section-heading"><h2>同期・送信などの履歴</h2></div>${state.jobs.length ? `<div class="history">${state.jobs.slice(0, 6).map(j => `<div class="history-row"><span class="history-icon ${j.status}" aria-hidden="true">${icon(j.status === 'success' ? 'check' : j.status === 'error' ? 'alert' : 'sync')}</span><div><strong>${escape(historyTitle(j.kind))}<span class="history-status">${j.status === 'success' ? '完了' : j.status === 'error' ? '完了できませんでした' : '進行中'}</span></strong><small class="history-date">${date(j.startedAt)}</small>${j.message && j.message !== '完了しました' && j.message !== '開始しました' ? `<p class="history-message">${escape(historyMessage(j.message))}</p>` : ''}</div>${j.status === 'error' ? recovery(j) : ''}</div>`).join('')}</div>` : '<p class="muted">同期・顔認識の更新・みてねへの送信・ログインの結果をここに表示します。</p>'}`;
}
function recovery(job: Job): string {
 const kind = job.kind;
 if(kind.endsWith('にログイン') || job.message.includes('ログイン')) return '<button class="button small" data-page="settings">ログインを確認</button>';
 if(kind === 'みてねへ送信') return `<button class="button small" data-page="photos" data-filter="${state.photos.some(p => p.uploadState === 'uncertain') ? 'uncertain' : 'candidates'}">送信結果を確認</button>`;
 if(kind === '候補を更新') return `<button class="button small" data-action="analyze" ${disabled()}>やり直す</button>`;
 if(kind === '写真・記録を取得') return `<button class="button small" data-action="sync" ${disabled() || (!state.codmonConnected ? 'disabled' : '')}>やり直す</button>`;
 return '';
}
function libraryName(path: string): string { return path ? path.split('/').find(p => p.endsWith('.photoslibrary')) || '選択したライブラリ' : '標準の写真ライブラリ'; }
function empty(title: string, body: string) { return `<div class="empty"><span class="empty-icon">${icon('photos')}</span><h3>${title}</h3><p>${body}</p></div>`; }
function matches(p: Photo, f: string) { return f === 'all' || (f === 'candidates' && ((available(p) && candidate(p) && !beforeAutoSend(p, state.settings)) || p.uploadState === 'sending')) || (f === 'older' && older(p)) || (f === 'others' && p.uploadState === 'pending' && !candidate(p)) || (f === 'sent' && (p.uploadState === 'sent' || p.uploadState === 'skipped')) || (f === 'uncertain' && p.uploadState === 'uncertain'); }
function visiblePhotos() { return state.photos.filter(p => matches(p, usesSelection() ? filter : 'all')); }
function photosView() {
 const s = state.settings;
 if(!usesSelection()) return `<div class="heading compact"><div><h1>写真</h1><p class="muted">このMacに保存した写真です。押すと大きく表示します。</p></div></div>${state.photos.length ? `<div class="photo-grid">${state.photos.map(p => photoCard(p, false)).join('')}</div>` : empty('まだ写真がありません','ホームの「今すぐ同期」で、コドモンの写真を取り込めます。')}<p class="muted helper">子どもが写った写真を選んだり、みてねへ送ったりするには、設定で子どもの名前を登録するか、みてねへの送信をオンにしてください。</p>`;
 const chosen = state.photos.filter(p => selected.has(p.id));
 const sendable = chosen.filter(available);
 const count = (f: string) => state.photos.filter(p => matches(p, f)).length;
 // タブは、どの写真もどれか1つに入る3つだけ。要確認・自動送信設定前の写真は、やることとしてタブの上に出す。
 const tabs: [string,string][] = !s.miteneEnabled ? [['candidates','まとめる写真'],['others','未選択'], ...(count('sent') ? [['sent','送信済み・送らない'] as [string,string]] : [])]
  : s.sendMode === 'automatic' ? [['sent','送信済み・送らない'],['others','未選択'],['candidates','送信待ち']]
  : [['candidates','送る候補'],['others','未選択'],['sent','送信済み・送らない']];
 const views: Record<string, string> = {older: 'みてね自動送信設定前の写真', uncertain: '送信できたか確認が必要な写真', all: 'すべての写真'};
 // 要確認・設定前の一覧は、片付いたり設定が変わったりして0枚になったら、通常のタブに戻す。
 if(!tabs.some(([id]) => id === filter) && (!views[filter] || (filter !== 'all' && !count(filter)))) filter = tabs[0][0];
 const photos = visiblePhotos();
 const from = monthDay(s.autoSendFrom);
 const lead = s.miteneEnabled ? (s.sendMode === 'automatic' ? `${s.people.length ? '子どもの顔が写った写真を自動で選び、' : '選択した写真を、'}次の同期でみてねに送ります。` : `${s.people.length ? '子どもの顔が写った写真は自動で選択されます。' : '送る写真を自分で選択します。'}確認して、チェックした写真をみてねに送ります。`) : '子どもの顔が写った写真を自動で選び、「写真」アプリの子どもごとのアルバムにまとめます。';
 const tasks = [
  s.miteneEnabled && !state.miteneConnected ? '<div class="alert warning"><span>みてねに送信するには、ログインが必要です。</span><button class="button small" data-login="mitene">みてねにログイン</button></div>' : '',
  count('uncertain') && filter !== 'uncertain' ? `<div class="alert warning"><span>送信できたか確認が必要な写真が${count('uncertain')}枚あります。</span><button class="button small" data-filter="uncertain">確認する →</button></div>` : '',
  count('older') && filter !== 'older' ? `<div class="alert info"><span>みてね自動送信設定前の写真が${count('older')}枚、まだ送られていません。</span><button class="button small" data-filter="older">一覧を見る →</button></div>` : '',
 ].join('');
 const nav = views[filter]
  ? `<div class="view-heading"><button class="text-button" data-filter="${tabs[0][0]}">← 写真一覧に戻る</button><h2>${views[filter]}<span class="count">${count(filter)}枚</span></h2></div>${filter === 'older' ? `<div class="alert info">みてねの自動送信を設定した${from}より前にコドモンに届いた写真です。自動では送らないので、送りたい写真にチェックして送ってください。すでにみてねにある写真は「送らない」にしてください。</div>` : filter === 'uncertain' ? '<div class="alert warning">送信を始めたものの、完了を確認できなかった写真です。二重投稿を防ぐため、自動では送り直しません。みてねで届いているかを確かめてから、結果を選んでください。チェックすると、まとめて選べます。</div>' : ''}`
  : `<div class="tabs-row"><div class="tabs" role="group" aria-label="写真の絞り込み">${tabs.map(([id,text]) => `<button class="tab ${filter === id ? 'active' : ''}" data-filter="${id}" aria-pressed="${filter === id}" aria-label="${text}（${count(id)}枚）">${text}<span class="count" aria-hidden="true">${count(id)}</span></button>`).join('')}</div><button class="text-button" data-filter="all">すべて表示</button></div>`;
 const sendButton = `<button class="button small primary" data-send ${!sendable.length || !state.miteneConnected || disabled() ? 'disabled' : ''}>${sendable.length ? `${sendable.length}枚を送信` : 'みてねに送信'}</button>`;
 // 設定前の写真では「送るか、送らないか」だけを決める。「外す」は子どもごとのアルバムからも外れるので、ここでは「送らない」として記録する。
 const actions = !chosen.length ? `<span>${filter === 'uncertain' ? 'チェックした写真の結果を、まとめて選べます。' : s.miteneEnabled ? 'チェックした写真を、まとめて送信・変更できます。' : 'チェックした写真を、まとめて変更できます。'}</span>`
  : filter === 'uncertain' ? `<span>${chosen.length}枚にチェック中</span><div class="selection-actions" role="group" aria-label="チェックした写真の送信結果"><button class="button small" data-resolve="sent" ${disabled()}>届いていた</button><button class="button small" data-resolve="retry" ${disabled()}>届いていない</button><button class="button small" data-resolve="skipped" ${disabled()}>送らない</button></div>`
  : filter === 'older' ? `<span>${chosen.length}枚にチェック中</span><div class="selection-actions"><button class="button small" data-seed ${chosen.length !== sendable.length || disabled() ? 'disabled' : ''}>送らない</button>${sendButton}</div>`
  : `<span>${chosen.length}枚にチェック中</span><div class="selection-actions"><button class="button small" data-bulk="include" ${disabled()}>選択する</button><button class="button small" data-bulk="exclude" ${disabled()}>選択から外す</button>${s.miteneEnabled ? sendButton : ''}</div>`;
 return `<div class="heading compact"><div><h1>写真</h1><p class="muted">${lead}</p></div>${s.people.length ? `<button class="button" data-action="analyze" ${disabled()}>顔認識を更新</button>` : ''}</div>${tasks}${nav}<div class="selection-bar"><label class="check"><input type="checkbox" id="select-all" ${photos.length && photos.every(p => selected.has(p.id)) ? 'checked' : ''} ${photos.length ? '' : 'disabled'}>表示中の写真すべてにチェック</label>${actions}</div>${photos.length ? `<div class="photo-grid">${photos.map(p => photoCard(p, true)).join('')}</div>` : empty('この条件に当てはまる写真はありません', views[filter] ? '「写真一覧に戻る」から、ほかの写真を見られます。' : 'ほかのタブを選んでください。')}${s.miteneEnabled ? `<details class="advanced"><summary>すでにみてねに送った写真を登録する</summary><p>このアプリを使う前に、手動でみてねに送った写真などを「送らない」にします。写真は送らず、今後も送る写真に出しません。</p><button class="button" data-seed ${!chosen.length || chosen.length !== sendable.length || disabled() ? 'disabled' : ''}>チェックした${chosen.length}枚を送らないことにする</button>${chosen.length !== sendable.length ? '<p class="helper">未送信で、選択から外していない写真だけにチェックしてください。</p>' : ''}</details>` : ''}`;
}
function photoCard(p: Photo, selectable: boolean) {
 const s = state.settings, name = escape(p.title || p.filename);
 // 未送信はふつうの状態なので、印を付けるのはそれ以外のときだけ。
 const badge = p.uploadState !== 'pending' ? `<span class="photo-status ${p.uploadState}">${label[p.uploadState]}</span>` : '';
 const decide = (value: Photo['decision'], text: string, cls: string) => `<button type="button" class="${cls}" data-decision="${escape(p.id)}" data-value="${value}" aria-label="${escape(p.filename)}：${text}" ${disabled()}>${text}</button>`;
 const children = selectable ? presentChildren(p) : [];
 // 名前はバッジで分かるので、写っている子どもを説明するだけの文は出さない。
 const reason = selectable && !(children.length && p.decision === 'auto') ? reasonText(p) : '';
 // 送信済み・要確認の写真は、送るかどうかをもう選べないので操作を出さない。
 // 設定前の写真の一覧では「送る／送らない」だけを決める。「外す」は子どものアルバムからも外れるので出さない。
 const decision = selectable && filter !== 'older' && (p.uploadState === 'pending' || !s.miteneEnabled) ? `<div class="decision">${candidate(p) ? `<span class="chosen">✓ 選択中</span>${decide('exclude', '外す', 'button small')}` : `<span class="not-chosen">未選択</span>${decide('include', '選択する', 'button small')}`}${p.decision !== 'auto' && s.people.length ? decide('auto', '自動に戻す', 'text-button') : ''}</div>` : '';
 return `<article class="photo-card ${selected.has(p.id) ? 'selected' : ''}"><div class="photo-image"><button class="photo-preview" data-preview="${escape(p.id)}" aria-label="${escape(p.filename)}を大きく見る"><img src="${photoURL(p, state.photos.indexOf(p))}" alt="${escape(p.title)}" loading="lazy"></button>${selectable ? `<label class="photo-select"><input type="checkbox" data-select="${escape(p.id)}" aria-label="${escape(p.filename)}にチェック" ${selected.has(p.id) ? 'checked' : ''}></label>` : ''}${children.length ? `<ul class="photo-children" aria-label="写っている子ども">${children.map(name => `<li>${escape(name)}</li>`).join('')}</ul>` : ''}${badge}</div><div class="photo-info"><small>${escape(day(p.date))}</small><h3>${name}</h3>${reason ? `<p class="reason">${escape(reason)}</p>` : ''}${decision}${p.importError ? `<p class="error-text">「写真」アプリ：${escape(p.importError)}</p>` : ''}${p.uploadState === 'uncertain' ? `<div class="resolve-actions" role="group" aria-label="送信結果"><button data-resolve="sent" data-id="${escape(p.id)}" ${disabled()}>届いていた</button><button data-resolve="retry" data-id="${escape(p.id)}" ${disabled()}>届いていない</button><button data-resolve="skipped" data-id="${escape(p.id)}" ${disabled()}>送らない</button></div>` : ''}</div></article>`;
}
const recordChildren = () => [...new Set(state.posts.flatMap(p => p.children ?? []))];
function recordView(r: RecordEntry, p: Snapshot['posts'][number], named: boolean) {
 const fields = r.fields.length ? `<dl class="record-fields">${r.fields.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>` : '';
 const items = r.items.length ? `<ul class="record-items">${r.items.map(i => `<li>${escape(i)}</li>`).join('')}</ul>` : '';
 return `<article class="record"><div class="record-meta"><span class="pill">${escape(r.kind)}</span><time datetime="${escape(p.date)}">${escape(day(p.date))}</time>${r.author ? `<span class="record-author">${escape(r.author)}</span>` : ''}${named && p.children?.length ? `<span class="record-child">${escape(p.children.join('・'))}</span>` : ''}</div>${r.title ? `<h2>${escape(r.title)}</h2>` : ''}${r.text ? `<p class="record-body">${escape(r.text)}</p>` : ''}${fields}${items}<div class="record-footer"><span>${r.attachments ? `添付ファイル ${r.attachments}件` : ''}</span><button class="text-button" data-post="${escape(p.id)}">記録ファイルを開く ↗</button></div></article>`;
}
function recordsView() {
 // Names and the filter only appear for siblings; one child's name on every record says nothing.
 const children = recordChildren(), named = children.length > 1;
 if(!named || !children.includes(recordChild)) recordChild = '';
 const posts = state.posts.filter(p => !recordChild || p.children?.includes(recordChild));
 const tab = (id: string, text: string) => `<button class="tab ${recordChild === id ? 'active' : ''}" data-record-child="${escape(id)}" aria-pressed="${recordChild === id}">${escape(text)}</button>`;
 return `<div class="heading compact"><div><h1>園の記録</h1><p class="muted">コドモンの連絡帳・お知らせ・活動記録を、取得した時点の内容で保存しています。</p></div></div>${named ? `<div class="tabs" role="group" aria-label="子どもで絞り込む">${tab('', 'すべて')}${children.map(c => tab(c, c)).join('')}</div>` : ''}${posts.length ? `<div class="records">${posts.map(p => recordView(recordEntry(p), p, named)).join('')}</div>` : empty('まだ記録がありません','同期すると、連絡帳や園からのお知らせがここに表示されます。')}`;
}
const input = (key: keyof Settings, text: string, value: string | number, type = 'text', hint = '', attrs = '') => `<div class="field"><label for="field-${key}">${text}</label><input id="field-${key}" name="${key}" type="${type}" value="${escape(value)}" ${type === 'number' ? 'step="any" min="0"' : ''} ${hint ? `aria-describedby="hint-${key}"` : ''} ${attrs}>${hint ? `<small id="hint-${key}">${hint}</small>` : ''}</div>`;
const check = (key: keyof Settings, text: string, on: boolean, hint = '') => `<label class="check setting-check"><input name="${key}" type="checkbox" ${on ? 'checked' : ''}><span>${text}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
const MAX_PEOPLE = 10;
const personRow = (p: Person) => `<div class="person-row"><label class="field">子どもの名前<input name="personName" value="${escape(p.name)}" autocomplete="off"></label><label class="field">その子のアルバム（任意）<input name="personAlbum" value="${escape(p.album)}" placeholder="空欄なら「${escape(state.settings.album)}（名前）」" autocomplete="off"></label><button type="button" class="button small" data-remove-person>削除</button></div>`;
function peopleField(people: Person[]) {
 const rows = people.length ? people : [{name: '', album: ''}];
 return `<fieldset class="people"><legend>顔認識で選ぶ子ども</legend><p class="helper">「写真」アプリの「ピープル」で付けた名前と同じ名前を入力します。きょうだいは一人ずつ追加します。空欄なら顔認識は使いません。</p><div class="people-rows">${rows.map(personRow).join('')}</div><button type="button" class="button small" data-add-person ${rows.length >= MAX_PEOPLE ? 'disabled' : ''}>＋ 子どもを追加</button></fieldset>`;
}
function formPeople(fd: FormData, keepEmpty = false): Person[] {
 const albums = fd.getAll('personAlbum').map(String);
 return fd.getAll('personName').map((name, i) => ({name: String(name).trim(), album: (albums[i] || '').trim()})).filter(p => keepEmpty || p.name);
}
const timeLabel = (kind: 'sync' | 'face') => kind === 'sync' ? '同期の時刻' : '顔認識の更新時刻';
const timeRow = (kind: 'sync' | 'face', value: string, index: number) => `<div class="time-row"><label class="field"><span class="sr-only">${timeLabel(kind)} ${index}</span><input type="time" name="${kind === 'sync' ? 'syncTime' : 'faceTime'}" value="${escape(value)}"></label><button type="button" class="icon-button" data-remove-time="${kind}" aria-label="${timeLabel(kind)} ${index}を削除">×</button></div>`;
function timeField(kind: 'sync' | 'face', values: string[]) {
 return `<fieldset class="time-list" data-time-list="${kind}"><legend>${timeLabel(kind)}</legend><div class="time-rows">${values.map((value, i) => timeRow(kind, value, i + 1)).join('')}<button type="button" class="button small" data-add-time="${kind}" ${kind === 'sync' && values.length >= 2 ? 'disabled' : ''}>＋ 追加</button></div></fieldset>`;
}
function draftTimes(name: 'syncTime' | 'faceTime', fallback: string[]): string[] {
 const form = document.querySelector<HTMLFormElement>('#settings-form');
 return form ? new FormData(form).getAll(name).map(String) : settingsDraft ? settingsDraft.getAll(name).map(String) : fallback;
}
function saveStatusText() { return saveState === 'saving' ? '設定を保存しています…' : saveState === 'unsaved' ? `未保存${saveError ? `：${saveError}` : 'の変更があります'}` : '設定は保存済みです'; }
function setSaveStatus(status: typeof saveState, message = '') {
 saveState = status; saveError = message;
 const target = document.querySelector<HTMLElement>('#settings-save-state');
 if(target) target.textContent = saveStatusText();
}
function settingsFromData(fd: FormData): {settings?: Settings; error?: string} {
 const settings = {...state.settings};
 settings.people = formPeople(fd);
 for(const k of ['saveRoot','album','photosLibrary','initialStartDate','miteneScope','sendMode'] as const) if(fd.has(k)) (settings as unknown as Record<string, unknown>)[k] = String(fd.get(k));
 for(const k of ['importPhotos','miteneEnabled','autoSync','launchAtLogin'] as const) settings[k] = fd.has(k);
 for(const k of ['faceMinPx','faceMinRatio','faceMainRatio','faceMaxPeople'] as const) settings[k] = Number(fd.get(k));
 const times = (key: 'syncTime' | 'faceTime') => fd.getAll(key).map(String);
 const syncTimes = times('syncTime'), faceTimes = times('faceTime');
 if(syncTimes.length > 2) return {error:'同期の時刻は2つまでです。'};
 for(const [label, values] of [['同期の時刻', syncTimes], ['顔認識の更新時刻', faceTimes]] as const) {
  if(values.some(v => !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))) return {error:`${label}に空の欄があります。時刻を入れるか、×で消してください。`};
  if(new Set(values).size !== values.length) return {error:`${label}に同じ時刻が2つあります。`};
 }
 settings.syncTimes = syncTimes.sort(); settings.faceTimes = faceTimes.sort();
 if(!settings.saveRoot.trim()) return {error:'写真・記録の保存先を選んでください。'};
 if(settings.faceMinRatio > 1 || settings.faceMainRatio > 1 || settings.faceMaxPeople < 0 || !Number.isInteger(settings.faceMaxPeople)) return {error:'顔の比率は0〜1、最大人数は0以上の整数（0は制限なし）で指定してください。'};
 return {settings};
}
function retryNote(ids: string[], automatic: boolean): string {
 if(!automatic) return '';
 const later = ids.filter(id => { const p = state.photos.find(x => x.id === id); return p && !beforeAutoSend(p, state.settings); }).length;
 return later === ids.length ? '自動送信がオンのため、次の同期で送信されます。' : !later ? '自動送信をオンにする前の写真なので、自動では送りません。写真画面から送れます。' : '自動送信をオンにした日以降の写真は、次の同期で送信されます。それより前の写真は、写真画面から送れます。';
}
function autoSendNotice(settings: Settings): string {
 const today = monthDay(new Date().toLocaleDateString('sv-SE'));
 return `今日（${today}）以降にコドモンに届いた写真から、選ばれたものを同期のたびに「${settings.miteneScope}」でみてねに送ります。それより前の写真は自動では送りません（写真画面から送れます）。`;
}
function scheduleAutosave(immediate = false) {
 if(saveTimer) clearTimeout(saveTimer);
 const revision = ++saveRevision;
 const form = document.querySelector<HTMLFormElement>('#settings-form');
 if(form) settingsDraft = new FormData(form);
 const parsed = settingsDraft ? settingsFromData(settingsDraft) : null;
 setSaveStatus('unsaved');
 const save = () => {
  if(!parsed) return;
  if(!parsed.settings) { if(revision === saveRevision) setSaveStatus('unsaved', parsed.error); return; }
  const settings = parsed.settings;
  if(settings.miteneEnabled && settings.sendMode === 'automatic' && (!state.settings.miteneEnabled || state.settings.sendMode !== 'automatic')) {
   void confirmDialog('自動で送るように変更しますか？', autoSendNotice(settings), '自動で送る').then(ok => {
    if(revision !== saveRevision) return;
    if(!ok) { const currentForm = document.querySelector<HTMLFormElement>('#settings-form'); const review = currentForm?.querySelector<HTMLInputElement>('input[name="sendMode"][value="review"]'); if(review) {review.checked = true; scheduleAutosave(true);} return; }
    enqueueSettingsSave(settings, revision);
   });
  } else enqueueSettingsSave(settings, revision);
 };
 if(immediate) save(); else saveTimer = setTimeout(save, 400);
}
async function saveSettingsAction(settings: Settings, revision: number): Promise<Snapshot | null> {
 while(revision === saveRevision) {
  try { const result = await api.action({type:'settings', settings}); return result && 'settings' in result ? result : null; }
  catch(e) {
   const message = errorMessage(e);
   if(!/処理を実行中|ほかの処理を実行中/.test(message)) throw e;
   await new Promise(resolve => setTimeout(resolve, 500));
  }
 }
 return null;
}
function enqueueSettingsSave(settings: Settings, revision: number) {
 saveQueue = saveQueue.catch(() => {}).then(async () => {
  if(revision !== saveRevision) return;
  setSaveStatus('saving');
  try {
   const result = await saveSettingsAction(settings, revision);
   if(revision !== saveRevision) return;
   if(result && 'settings' in result) state = result;
   settingsDraft = null; setSaveStatus('saved');
  } catch(e) {
   if(revision === saveRevision) setSaveStatus('unsaved', errorMessage(e));
  }
 });
}
function settingsView(isSetup: boolean) {
 const s = state.settings;
 const syncTimes = draftTimes('syncTime', s.syncTimes);
 const faceTimes = draftTimes('faceTime', s.faceTimes);
 // セクションの番号は、はじめの設定で手順として見せるときだけ付ける。
 const section = (id: string, n: number, title: string, body: string, optional = false, lead = '') => `<section class="settings-card" id="settings-${id}"><div class="section-title">${isSetup ? `<span>${n}</span>` : ''}<div><h2>${title}${optional ? ' <em>任意</em>' : ''}</h2>${lead ? `<p>${lead}</p>` : ''}</div></div>${body}</section>`;
 const login = (provider: 'codmon' | 'mitene', name: string, connected: boolean) => `<div class="connection"><span class="pill ${connected ? '' : 'warning-pill'}">${connected ? 'ログイン済み' : 'ログインが必要'}</span><button type="button" class="button" data-login="${provider}" ${disabled()}>${connected ? `${name}にログインし直す` : `${name}にログイン`}</button></div>`;
 const codmon = section('codmon', 1, 'コドモンと保存先', `${login('codmon', 'コドモン', state.codmonConnected)}<div class="path-field">${input('saveRoot','写真・記録の保存先',s.saveRoot)}<button type="button" class="button" data-choose="chooseFolder" ${disabled()}>フォルダを選ぶ</button></div>${isSetup ? input('initialStartDate','この日以降を取り込む',s.initialStartDate || '2000-01-01','date','初期値のままなら、コドモンで見られるすべての期間を取り込みます。') : ''}`, false, 'ログインは専用のブラウザで行います。パスワードはこのアプリに保存しません。');
 const sync = section('sync', 2, '自動同期', `${check('autoSync','決まった時刻に自動で同期する',s.autoSync)}<div data-shown-by="autoSync">${timeField('sync', syncTimes)}<p class="helper">コドモンからの取り込みは、手動の同期も含めて1日2回までです（時刻を変えても回数は戻りません）。スリープ中だった時刻の分は、復帰後に実行します。</p></div>${check('launchAtLogin','Macにログインしたときに起動する',s.launchAtLogin,'ウィンドウを閉じても、メニューバーの双葉のアイコンから開けます。終了するには、メニューの「終了」か ⌘Q を使います。')}`);
 const photos = section('photos', 3, 'Macの「写真」アプリ', `${check('importPhotos','Macの「写真」アプリに取り込む',s.importPhotos,'初回は、「写真」アプリを操作する許可を求められます。')}<div data-shown-by="importPhotos">${input('album','取り込み先のアルバム',s.album)}${peopleField(draftPeople ?? s.people)}<div class="permission"><p class="helper">顔認識には「フルディスクアクセス」の許可が必要です。「写真」アプリで顔の解析が終わっていない写真は、まだ選ばれません。</p><button type="button" class="button small" data-action="openPrivacy">許可の設定を開く ↗</button></div><details class="advanced"><summary>詳細設定（通常は変更不要）</summary>${timeField('face', faceTimes)}<p class="helper">自動同期がオンのとき、この時刻に顔認識を更新します（「写真」アプリの顔認識の結果を読み直します）。</p><div class="library-setting"><div><strong>写真ライブラリ</strong><p class="library-name muted">${escape(libraryName(s.photosLibrary))}</p></div><button type="button" class="button" data-choose="chooseLibrary" ${disabled()}>ライブラリを選ぶ</button></div><p class="helper">「写真」アプリで別のライブラリを使っている場合だけ選びます。</p><details class="advanced"><summary>ライブラリの場所を直接入力する</summary>${input('photosLibrary','ライブラリの場所',s.photosLibrary)}</details><h3 class="subheading">顔認識の判定条件</h3><p class="helper">次のどちらかを満たす写真を選びます。（1）顔が「最小サイズ」と「最小比率」の両方を満たす。（2）顔が「主役とみなす比率」以上で、写っている人数が「最大人数」以内。</p><div class="form-grid">${input('faceMinPx','顔の最小サイズ（ピクセル）',s.faceMinPx,'number','顔の幅です。')}${input('faceMinRatio','顔の最小比率（0〜1）',s.faceMinRatio,'number','写真の中で一番大きな顔に対する大きさです。','max="1"')}${input('faceMainRatio','主役とみなす比率（0〜1）',s.faceMainRatio,'number','','max="1"')}${input('faceMaxPeople','最大人数',s.faceMaxPeople,'number','0なら人数で制限しません。')}</div></details></div>`, true, '取り込んだ写真から、子どもが写ったものを顔認識で選べます。');
 const mitene = section('mitene', 4, 'みてねへの送信', `${check('miteneEnabled','みてねへの送信を使う',s.miteneEnabled,'有料の「プレミアムFamily」または「プレミアムFamily Pro」が必要です。無料版・プレミアムOneでは使えません。')}<div data-shown-by="miteneEnabled">${login('mitene', 'みてね', state.miteneConnected)}<fieldset><legend>送り方</legend><label class="mode-option"><input type="radio" name="sendMode" value="review" ${s.sendMode === 'review' ? 'checked' : ''}><span><strong>確認してから送る</strong><small>写真画面で、送りたい写真にチェックして送ります。</small></span><span class="recommended">おすすめ</span></label><label class="mode-option"><input type="radio" name="sendMode" value="automatic" ${s.sendMode === 'automatic' ? 'checked' : ''}><span><strong>自動で送る</strong><small>${s.autoSendFrom ? `${monthDay(s.autoSendFrom)}以降にコドモンに届いた写真から、選ばれたものを同期のたびに送ります。` : '選ばれた写真を、同期のたびに送ります。この設定にした日以降にコドモンに届いた写真が対象です。'}</small></span></label></fieldset><label class="field">みてねでの公開範囲<select name="miteneScope"><option ${s.miteneScope === '家族みんなに公開' ? 'selected' : ''}>家族みんなに公開</option><option ${s.miteneScope === '管理者のみ' ? 'selected' : ''}>管理者のみ</option></select></label></div>`, true, '選んだ写真を家族アルバム「みてね」に送ります。');
 const heading = `<div class="heading compact"><div><h1>${isSetup ? 'はじめの設定' : '設定'}</h1><p class="muted">${isSetup ? 'コドモンへのログインと保存先を決めれば使いはじめられます。「写真」アプリ・みてねは、あとからでも設定できます。' : '変更は自動で保存されます。設定はこのMacにだけ保存されます。'}</p></div></div>`;
 const footer = `<div class="form-footer"><p class="muted" id="settings-save-state" role="status" aria-live="polite">${saveStatusText()}</p>${isSetup ? '<button class="button primary" type="submit" data-finish-setup>はじめる</button>' : ''}</div>`;
 const extras = isSetup ? '' : `<h2 class="settings-group">その他</h2><section class="settings-card"><h2>コドモンから期間を指定して取り込む</h2><p class="muted">前の期間の写真を追加で取り込んだり、失敗した期間を取り込み直したりできます。保存済みの写真は二重に保存しません。</p><form id="period-form"><div class="form-grid"><label class="field">開始日<input type="date" name="startDate" required value="${escape(s.initialStartDate || '2000-01-01')}"></label><label class="field">終了日<input type="date" name="endDate" required value="${new Date().toLocaleDateString('sv-SE')}"></label></div>${s.sendMode === 'automatic' && s.miteneEnabled ? `<p class="helper">みてねの自動送信がオンです。${monthDay(s.autoSendFrom)}以降にコドモンに届いた写真で選ばれたものは、取り込んだあと自動で送ります。それより前の写真は自動では送りません。</p>` : ''}<button class="button" type="submit" ${disabled() || (!state.codmonConnected ? 'disabled' : '')}>この期間を取り込む</button></form></section><section class="settings-card"><h2>このアプリについて</h2>${state.version ? `<p>お使いのバージョン：${escape(state.version)}</p>` : ''}<p class="muted">コドモン・みてねの運営会社とは関係ありません。</p><button class="button" data-action="checkUpdate" ${disabled()}>アップデートを確認</button>${state.update ? `<p class="update-note">新しいバージョン ${escape(state.update.version)} があります（お使いのバージョンは ${escape(state.version)}）。</p><button class="button" data-action="openUpdate">ダウンロードページを開く ↗</button>` : ''}</section>`;
 return `${heading}<form id="settings-form">${codmon}${sync}${photos}${mitene}${footer}</form>${extras}`;
}
// 親のチェックがオフの項目は隠す。値はフォームに残るので、保存内容は変わらない。
function syncShown(form: HTMLFormElement) {
 form.querySelectorAll<HTMLElement>('[data-shown-by]').forEach(el => {el.hidden = !(form.elements.namedItem(el.dataset.shownBy!) as HTMLInputElement | null)?.checked;});
}
async function run(action: Action, message = '') {
 if (working || state.busy) return null;
 working = true; error = ''; notice = ''; render();
 try { const result = await api.action(action); if(result && 'settings' in result) state = result; if(result !== null) notice = message; return result; }
 catch(e) { error = errorMessage(e); return null; }
 finally { working = false; render(); }
}
async function confirmDialog(title: string, description: string, confirm: string): Promise<boolean> {
 const dialog = document.querySelector<HTMLDialogElement>('#confirm-dialog')!;
 dialog.innerHTML = `<form method="dialog"><h2 id="confirm-title">${escape(title)}</h2><p>${escape(description)}</p><div class="dialog-actions"><button class="button" value="cancel" autofocus>キャンセル</button><button class="button primary" value="confirm">${escape(confirm)}</button></div></form>`;
 dialog.showModal();
 return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true}));
}
async function act(action: Action, done: string) { const result = await run(action, done); if(result) { selected.clear(); render(); } }
function bind() {
 app.querySelectorAll<HTMLElement>('[data-preview]').forEach(b => b.addEventListener('click', () => {
  const photo = state.photos.find(p => p.id === b.dataset.preview)!;
  const dialog = document.querySelector<HTMLDialogElement>('#photo-dialog')!;
  const status = state.settings.miteneEnabled || photo.uploadState !== 'pending' ? ` · ${label[photo.uploadState]}` : '';
  dialog.innerHTML = `<form method="dialog"><div class="section-heading"><div><h2 id="photo-title">${escape(photo.title || photo.filename)}</h2><small>${escape(day(photo.date))} · ${escape(photo.filename)}${status}</small></div><button class="button" autofocus>閉じる</button></div><img class="full-photo" src="${photoURL(photo,state.photos.indexOf(photo))}" alt="${escape(photo.title)}">${usesSelection() ? `<p>${escape(reasonText(photo))}</p>` : ''}</form>`;
  dialog.showModal();
 }));
 app.querySelector('.brand')?.addEventListener('click', e => {e.preventDefault(); if(!state.settings.setupComplete) return; page = 'overview'; setup = false; render();});
 app.querySelectorAll<HTMLElement>('[data-page]').forEach(b => b.addEventListener('click', () => { page = b.dataset.page as typeof page; setup = false; if(b.dataset.filter) filter = b.dataset.filter; else if(['older','uncertain','all'].includes(filter)) filter = ''; selected.clear(); render(); window.scrollTo(0,0); }));
 app.querySelectorAll<HTMLElement>('[data-filter]:not([data-page])').forEach(b => b.addEventListener('click', () => {filter = b.dataset.filter!; selected.clear(); render();}));
 app.querySelectorAll<HTMLElement>('[data-dismiss]').forEach(b => b.addEventListener('click', () => {if(b.dataset.dismiss === 'error') error = ''; else notice = ''; render();}));
 app.querySelectorAll<HTMLElement>('[data-action]').forEach(b => b.addEventListener('click', () => {const type = b.dataset.action as Action['type']; void run({type} as Action, type === 'sync' ? '同期が完了しました。' : type === 'analyze' ? '顔認識を更新しました。' : '');}));
 app.querySelectorAll<HTMLElement>('[data-login]').forEach(b => b.addEventListener('click', () => {const provider = b.dataset.login as 'codmon' | 'mitene'; void run({type:'login', provider}, `${provider === 'codmon' ? 'コドモン' : 'みてね'}にログインしました。`);}));
 app.querySelectorAll<HTMLInputElement>('[data-select]').forEach(b => b.addEventListener('change', () => {b.checked ? selected.add(b.dataset.select!) : selected.delete(b.dataset.select!); render();}));
 app.querySelector('#select-all')?.addEventListener('change', e => {for(const p of visiblePhotos()) (e.target as HTMLInputElement).checked ? selected.add(p.id) : selected.delete(p.id); render();});
 app.querySelectorAll<HTMLButtonElement>('[data-decision]').forEach(b => b.addEventListener('click', () => {const value = b.dataset.value as Photo['decision']; void run({type:'decision', ids:[b.dataset.decision!], decision:value}, value === 'include' ? '選択しました。' : value === 'exclude' ? '選択から外しました。' : '子どもの顔で自動で選ぶように戻しました。');}));
 app.querySelectorAll<HTMLElement>('[data-bulk]').forEach(b => b.addEventListener('click', () => {const n = selected.size; void act({type:'decision', ids:[...selected], decision:b.dataset.bulk as Photo['decision']}, `${n}枚を${b.dataset.bulk === 'include' ? '選択しました' : '選択から外しました'}。`);}));
 app.querySelector('[data-send]')?.addEventListener('click', async () => {const ids = state.photos.filter(p => selected.has(p.id) && available(p)).map(p => p.id); const skipped = selected.size - ids.length; if(await confirmDialog(`${ids.length}枚をみてねに送信しますか？`, `公開範囲：${state.settings.miteneScope}。${skipped ? `チェックした写真のうち、送信済み・選択から外した${skipped}枚は送りません。` : ''}送信後は、このアプリからは取り消せません。`, `${ids.length}枚を送信`)) await act({type:'send', ids}, `${ids.length}枚の送信が完了しました。`);});
 app.querySelectorAll('[data-seed]').forEach(b => b.addEventListener('click', async () => {const ids = [...selected]; if(await confirmDialog(`${ids.length}枚を送らないことにしますか？`, 'みてねには送らず、今後も送る写真に出しません。', '送らない')) await act({type:'seed', ids}, `${ids.length}枚を送らないことにしました。`);}));
 app.querySelectorAll<HTMLElement>('[data-resolve]').forEach(b => b.addEventListener('click', async () => {
  const resolution = b.dataset.resolve as 'sent' | 'retry' | 'skipped';
  // 写真ごとのボタンはその1枚、一覧の上のボタンはチェックした写真をまとめて変える。
  const ids = b.dataset.id ? [b.dataset.id] : state.photos.filter(p => selected.has(p.id) && p.uploadState === 'uncertain').map(p => p.id);
  if(!ids.length) return;
  const target = ids.length > 1 ? `${ids.length}枚を` : '';
  const automatic = state.settings.sendMode === 'automatic' && state.settings.miteneEnabled;
  const [title, body, button] = resolution === 'sent' ? [`${target}送信済みにしますか？`, 'みてねに届いていることを確かめた写真だけを、送信済みにしてください。', '送信済みにする'] : resolution === 'retry' ? [`${target}未送信に戻しますか？`, `みてねに届いていないことを確かめてから戻してください。届いているのに戻すと、同じ写真が二重に投稿されます。${retryNote(ids, automatic)}`, '未送信に戻す'] : [`${ids.length > 1 ? `${ids.length}枚の写真` : 'この写真'}を送らないことにしますか？`, 'みてねには送らず、今後も送る写真に出しません。', '送らない'];
  if(await confirmDialog(title, body, button)) await act({type:'resolve', ids, resolution}, `${target}${resolution === 'sent' ? '送信済みにしました。' : resolution === 'retry' ? '未送信に戻しました。' : '送らないことにしました。'}`);
 }));
 app.querySelectorAll<HTMLElement>('[data-record-child]').forEach(b => b.addEventListener('click', () => {recordChild = b.dataset.recordChild!; render();}));
 app.querySelector('[data-add-person]')?.addEventListener('click', e => {const rows = app.querySelector('.people-rows')!; rows.insertAdjacentHTML('beforeend', personRow({name: '', album: ''})); bindPersonRows(); (rows.lastElementChild!.querySelector('input') as HTMLInputElement).focus(); (e.currentTarget as HTMLButtonElement).disabled = rows.children.length >= MAX_PEOPLE; scheduleAutosave(true);});
 bindPersonRows();
 app.querySelectorAll<HTMLButtonElement>('[data-add-time]').forEach(button => button.addEventListener('click', () => {
  const kind = button.dataset.addTime as 'sync' | 'face', fieldset = button.closest<HTMLElement>('[data-time-list]')!, rows = fieldset.querySelector<HTMLElement>('.time-rows')!;
  if(kind === 'sync' && rows.querySelectorAll('.time-row').length >= 2) return;
  button.insertAdjacentHTML('beforebegin', timeRow(kind, '', rows.querySelectorAll('.time-row').length + 1));
  button.disabled = kind === 'sync' && rows.querySelectorAll('.time-row').length >= 2;
  scheduleAutosave(true);
  (button.previousElementSibling!.querySelector('input') as HTMLInputElement).focus();
 }));
 const settingsForm = app.querySelector<HTMLFormElement>('#settings-form');
 settingsForm?.addEventListener('click', e => {
  const button=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-time]');if(!button)return;
  const fieldset = button.closest<HTMLElement>('[data-time-list]')!, rows = fieldset.querySelector<HTMLElement>('.time-rows')!;
  button.closest('.time-row')?.remove();
  const kind = fieldset.dataset.timeList as 'sync' | 'face';
  rows.querySelectorAll('.time-row').forEach((row, i) => {row.querySelector('.sr-only')!.textContent = `${timeLabel(kind)} ${i + 1}`; row.querySelector('button')!.setAttribute('aria-label', `${timeLabel(kind)} ${i + 1}を削除`);});
  const add = fieldset.querySelector<HTMLButtonElement>('[data-add-time]'); if(add) add.disabled = kind === 'sync' && rows.querySelectorAll('.time-row').length >= 2;
  scheduleAutosave(true);
 });
 settingsForm?.addEventListener('input', e => {const target = e.target as HTMLInputElement; if(target.type !== 'checkbox' && target.type !== 'radio') scheduleAutosave(false);});
 settingsForm?.addEventListener('change', () => {syncShown(settingsForm); scheduleAutosave(true);});
 app.querySelectorAll<HTMLElement>('[data-post]').forEach(b => b.addEventListener('click', () => {void run({type:'openPost', id:b.dataset.post!});}));
 app.querySelectorAll<HTMLElement>('[data-choose]').forEach(b => b.addEventListener('click', async () => {const form = document.querySelector<HTMLFormElement>('#settings-form')!; const draft = new FormData(form); const result = await run({type:b.dataset.choose as 'chooseFolder' | 'chooseLibrary'}); const current = document.querySelector<HTMLFormElement>('#settings-form'); if(current) restoreForm(current, draft); if(result && 'path' in result && current) { (current.elements.namedItem(b.dataset.choose === 'chooseFolder' ? 'saveRoot' : 'photosLibrary') as HTMLInputElement).value = result.path; if(b.dataset.choose === 'chooseLibrary') current.querySelector('.library-name')!.textContent = libraryName(result.path); scheduleAutosave(true); }}));
 app.querySelector<HTMLFormElement>('#period-form')?.addEventListener('submit', async e => {
  e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const fd = new FormData(form);
  const startDate = String(fd.get('startDate') || ''); const endDate = String(fd.get('endDate') || '');
  if(!startDate || !endDate || startDate > endDate) {error = '終了日には、開始日と同じ日かそれより後の日付を指定してください。'; showFormError(form); return;}
  await run({type:'sync', startDate, endDate}, `${day(startDate)}〜${day(endDate)}の取り込みが完了しました。`);
 });
 settingsForm?.addEventListener('submit', async e => {
  e.preventDefault(); const form = e.currentTarget as HTMLFormElement;
  if(state.settings.setupComplete) return;
  const parsed = settingsFromData(new FormData(form)); if(!parsed.settings) {setSaveStatus('unsaved', parsed.error); return;}
  if(!state.codmonConnected) {setSaveStatus('unsaved', '先にコドモンにログインしてください。'); return;}
  const settings = parsed.settings;
  if(settings.miteneEnabled && settings.sendMode === 'automatic' && (!state.settings.miteneEnabled || state.settings.sendMode !== 'automatic')) {
   if(!await confirmDialog('自動で送るように変更しますか？', autoSendNotice(settings), '自動で送る')) return;
  }
  if(saveTimer) clearTimeout(saveTimer);
  const revision = ++saveRevision; settings.setupComplete = true;
  saveQueue = saveQueue.catch(() => {}).then(async () => {
   if(revision !== saveRevision) return;
   setSaveStatus('saving');
   try { const result = await saveSettingsAction(settings, revision); if(revision !== saveRevision || !result) return; if(result && 'settings' in result) state = result; settingsDraft = null; setSaveStatus('saved'); setup = false; render(); }
   catch(e) {if(revision === saveRevision) setSaveStatus('unsaved', errorMessage(e));}
  });
 });
}
function bindPersonRows() {
 app.querySelectorAll<HTMLButtonElement>('[data-remove-person]').forEach(b => b.onclick = () => {
  const row = b.closest('.person-row')!, rows = row.parentElement!;
  if(rows.children.length > 1) row.remove(); else row.querySelectorAll('input').forEach(i => i.value = '');
  const add = app.querySelector<HTMLButtonElement>('[data-add-person]'); if(add) add.disabled = rows.children.length >= MAX_PEOPLE;
  (rows.querySelector('input') as HTMLInputElement | null)?.focus();
  scheduleAutosave(true);
 });
}
function showFormError(form: HTMLFormElement) {let el = form.querySelector<HTMLElement>('.form-error'); if(!el) {el = document.createElement('p'); el.className = 'alert error form-error'; el.setAttribute('role','alert'); form.prepend(el);} el.textContent = error; el.scrollIntoView({block:'center'});}
function restoreForm(form: HTMLFormElement, fd: FormData) {
 // Repeated fields (one per child) are restored by position.
 const seen = new Map<string, number>(), value = (name: string) => { const i = seen.get(name) ?? 0; seen.set(name, i + 1); return String(fd.getAll(name)[i] ?? ''); };
 for(const element of Array.from(form.elements)) {if(element instanceof HTMLInputElement) {if(element.type === 'checkbox') element.checked = fd.has(element.name); else if(element.type === 'radio') element.checked = fd.get(element.name) === element.value; else element.value = value(element.name);} else if(element instanceof HTMLSelectElement) element.value = value(element.name);}
}
document.addEventListener('keydown', e => {if(e.key === 'Tab') document.documentElement.dataset.keyboardFocus = 'true';});
document.addEventListener('pointerdown', () => {delete document.documentElement.dataset.keyboardFocus;}, {capture:true});
api.onChange(s => {state = s; if(!document.querySelector('dialog[open]') && !document.querySelector('#settings-form')) render();});
api.snapshot().then(s => {state = s; render();}).catch(e => {app.innerHTML = `<div class="startup-error"><h1>おむかえフォトを開けませんでした</h1><p>${escape(errorMessage(e))}</p><button class="button" id="reload-app">もう一度読み込む</button></div>`; document.querySelector('#reload-app')?.addEventListener('click', () => location.reload());});
