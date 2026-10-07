import type { DesktopApi, Snapshot, Action } from '../shared/types';
const defaults: Snapshot = {
  settings: { saveRoot: '/Users/demo/Pictures/おむかえフォト', album: 'コドモン', people: [{name: 'さくら', album: ''}, {name: 'はると', album: ''}], photosLibrary: '', importPhotos: true, sendMode: 'review', miteneEnabled: true, miteneScope: '家族みんなに公開', autoSync: true, launchAtLogin: false, initialStartDate: '2000-01-01', faceMinPx: 50, faceMinRatio: .08, faceMainRatio: .6, faceMaxPeople: 5, setupComplete: true },
  photos: Array.from({length: 8}, (_, i) => ({ id: `demo-${i}`, filename: `sample-${i}.jpg`, path: '', date: `2026-10-0${i < 4 ? 2 : 1}`, title: i < 4 ? '秋の色をさがしに' : 'お部屋でつくって遊ぼう', postId: i < 4 ? 'post-1' : 'post-2', decision: i === 7 ? 'exclude' : 'auto', autoSelected: i < 4, reason: i < 2 ? 'さくらが写っています' : i < 4 ? 'さくら・はるとが写っています' : i === 4 ? 'はると：顔が小さめです（38px・6人）' : '対象の人物が見つかりません', uploadState: i === 0 ? 'sent' : i === 6 ? 'uncertain' : 'pending', imported: true, importError: null, sentAt: i === 0 ? '2026-10-02T08:00:00Z' : null })),
  posts: [{id: 'post-1', date: '2026-10-02', kind: '活動記録', title: '秋の色をさがしに', body: '園庭で色づいた葉っぱを見つけました。\nみんなで拾った葉っぱを並べて、色や形の違いを楽しんでいます。', path: '', attachments: [], children: ['さくら', 'はると']}, {id: 'post-2', date: '2026-10-01', kind: 'comments', title: '', body: JSON.stringify({memo: '積み木を組み合わせて、大きな街ができました。\nこれは表示確認のための架空の記録です。', meal: '主食　完食\n主菜　おかわり', tempratures: [{temprature: '36.8', temprature_time: '14:20:00'}], sleepings: '12:30〜14:40', mood_morning: '良', mood_afternoon: '良', evacuations: []}), path: '', attachments: [], children: ['はると']}],
  jobs: [{id: 1, kind: '写真・記録を取得', startedAt: '2026-10-02T08:30:00Z', endedAt: '2026-10-02T08:30:10Z', status: 'success', message: '写真8枚と記録2件を保存しました'}], busy: false, progress: '', codmonConnected: true, miteneConnected: false, platform: 'darwin', demo: true, update: null,
};
export function createDemo(): DesktopApi {
  let state = structuredClone(defaults);
  const listeners = new Set<(s: Snapshot) => void>();
  const snapshot = () => structuredClone(state);
  return { snapshot: async () => snapshot(), onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }, async action(action: Action) {
    if (action.type === 'chooseFolder') return {path: '/Users/demo/Pictures/おむかえフォト'};
    if (action.type === 'chooseLibrary') return {path: '/Users/demo/Pictures/Photos Library.photoslibrary'};
    if (action.type === 'settings') state.settings = structuredClone(action.settings);
    if (action.type === 'login') { if(action.provider === 'codmon') state.codmonConnected = true; else state.miteneConnected = true; }
    if (action.type === 'decision') state.photos.forEach(p => {if(action.ids.includes(p.id)) p.decision = action.decision;});
    if (action.type === 'send' || action.type === 'seed') state.photos.forEach(p => {if(action.ids.includes(p.id)) {p.uploadState = action.type === 'seed' ? 'skipped' : 'sent'; p.sentAt = new Date().toISOString();}});
    if (action.type === 'resolve') state.photos.forEach(p => {if(action.ids.includes(p.id)) p.uploadState = action.resolution === 'retry' ? 'pending' : action.resolution;});
    if (action.type === 'sync' || action.type === 'analyze') state.jobs.unshift({id: Date.now(), kind: action.type === 'sync' ? '写真・記録を取得' : '候補を更新', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status:'success', message:'デモの処理が完了しました。実際の通信は行っていません。'});
    listeners.forEach(cb => cb(snapshot())); return snapshot();
  }};
}
export function demoImage(index: number): string {
 const colors = [['#e5ba79','#697f52'],['#bfd0bd','#4e705b'],['#dfbeb3','#af7053'],['#a8c2ce','#677f95']][index % 4];
 const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="${colors[0]}"/><circle cx="500" cy="90" r="65" fill="#fff" opacity=".35"/><path d="M0 330 Q130 180 290 350 Q420 240 640 340 V480 H0" fill="${colors[1]}" opacity=".55"/><path d="M0 400 Q180 280 340 410 Q500 330 640 380 V480 H0" fill="${colors[1]}"/><g fill="#fff" opacity=".8"><ellipse cx="260" cy="220" rx="32" ry="68" transform="rotate(-35 260 220)"/><ellipse cx="321" cy="220" rx="28" ry="62" transform="rotate(35 321 220)"/><path d="M285 260 L290 355" stroke="#fff" stroke-width="6"/></g><text x="24" y="38" font-size="16" fill="#fff" font-family="sans-serif">SAMPLE · ${index + 1}</text></svg>`;
 return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
