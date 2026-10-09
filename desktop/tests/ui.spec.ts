import { test, expect } from '@playwright/test';
test('demo overview is isolated and shows fixture status', async ({page}) => {
 await page.goto('/'); await expect(page.getByText('体験用のデモです', {exact:false})).toBeVisible();
 await expect(page.getByRole('heading', {name:'写真8枚と記録2件を保存しています'})).toBeVisible();
 await page.getByRole('button', {name:'園の記録', exact:true}).click();
 await expect(page.getByRole('heading', {name:'秋の色をさがしに'})).toBeVisible();
});
test('siblings: records filter by child, and children can be added and removed in settings', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'園の記録', exact:true}).click();
 await expect(page.locator('.record')).toHaveCount(2);
 await page.getByRole('button', {name:'さくら', exact:true}).click();
 await expect(page.locator('.record')).toHaveCount(1);
 await expect(page.locator('.record-child')).toHaveText('さくら・はると');
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.getByLabel('子どもの名前')).toHaveCount(2);
 await page.getByRole('button', {name:'＋ 子どもを追加'}).click();
 await page.getByLabel('子どもの名前').nth(2).fill('みお');
 await page.locator('[data-remove-person]').first().click();
 await expect(page.getByLabel('子どもの名前').last()).toHaveValue('みお');
 await page.getByRole('button', {name:'ホーム',exact:true}).click(); await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.getByLabel('子どもの名前')).toHaveCount(2);
 await expect(page.getByLabel('子どもの名前').first()).toHaveValue('はると');
 await expect(page.getByLabel('子どもの名前').last()).toHaveValue('みお');
});
test('manual selection persists when switching tabs', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'写真', exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(3);
 await expect(page.locator('.photo-card').nth(1).locator('.photo-children li')).toHaveText(['さくら','はると']);
 await page.locator('[data-decision][data-value="exclude"]').first().click();
 await expect(page.locator('.photo-card')).toHaveCount(2);
 await page.getByRole('button', {name:/^未選択/}).click();
 await expect(page.locator('.photo-card')).toHaveCount(4);
 await expect(page.locator('[data-decision][data-value="auto"]')).toHaveCount(2);
});
test('uncertain result requires explicit resolution', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'確認する →', exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(1);
 await page.getByRole('button', {name:'届いていない',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('届いていないことを確かめて');
 await page.getByRole('button', {name:'キャンセル', exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(1);
 await page.getByRole('button', {name:'届いていた',exact:true}).click();
 await page.getByRole('button', {name:'送信済みにする',exact:true}).click();
 await expect(page.getByRole('group', {name:'写真の絞り込み'})).toBeVisible();
 await expect(page.getByRole('heading', {name:/^送信できたか確認が必要な写真/})).toHaveCount(0);
});
test('uncertain results can be resolved together for checked photos', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'確認する →', exact:true}).click();
 await page.getByLabel('表示中の写真すべてにチェック').check();
 await page.getByRole('group', {name:'チェックした写真の送信結果'}).getByRole('button', {name:'届いていた',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('届いていることを確かめた写真だけ');
 await page.getByRole('button', {name:'送信済みにする',exact:true}).click();
 await expect(page.getByRole('group', {name:'写真の絞り込み'})).toBeVisible();
 await expect(page.getByRole('heading', {name:/^送信できたか確認が必要な写真/})).toHaveCount(0);
});
test('review is default, automatic requires confirmation and selected send has scope', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.getByRole('radio', {name:/確認してから送る/})).toBeChecked();
 await page.getByRole('button', {name:'みてねにログイン',exact:true}).click();
 await page.getByLabel('みてねへの送信を使う').check();
 await page.getByRole('radio', {name:/自動で送る/}).check();
 await expect(page.getByRole('dialog')).toContainText('それより前の写真は自動では送りません');
 await page.getByRole('button', {name:'キャンセル',exact:true}).click();
 await page.getByRole('radio', {name:/確認してから送る/}).check();
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
 await page.getByRole('button',{name:'ホーム',exact:true}).click(); await page.getByRole('button',{name:'設定',exact:true}).click();
 await expect(page.getByRole('radio',{name:/確認してから送る/})).toBeChecked();
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await page.getByLabel('表示中の写真すべてにチェック').check();
 await page.getByRole('button', {name:'3枚を送信',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('公開範囲：家族みんなに公開');
 await page.getByRole('dialog').getByRole('button', {name:'3枚を送信',exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(0);
});
test('automatic sending leaves earlier photos for review from home', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByRole('radio', {name:/自動で送る/}).check();
 await page.getByRole('dialog').getByRole('button', {name:'自動で送る',exact:true}).click();
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
 await page.getByRole('button', {name:'ホーム',exact:true}).click();
 await page.getByRole('button', {name:'一覧を見る →',exact:true}).click();
 await expect(page.getByRole('heading', {name:/^みてね自動送信設定前の写真/})).toBeVisible();
 await expect(page.locator('.photo-card')).toHaveCount(3);
 await page.getByRole('button', {name:'← 写真一覧に戻る',exact:true}).click();
 await expect(page.getByRole('button', {name:'送信済み・送らない（1枚）',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('button', {name:'送信待ち（0枚）',exact:true})).toBeVisible();
});
test('narrow layout stays within viewport and navigation works', async ({page}) => {
 await page.setViewportSize({width: 390,height:844}); await page.goto('/');
 await page.getByRole('button', {name:'写真',exact:true}).click();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.getByRole('heading', {name:'設定',exact:true})).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('focus outlines appear for keyboard navigation and clear for pointer input', async ({page}) => {
 await page.goto('/');
 const settingsButton = page.getByRole('button', {name:'設定',exact:true});
 await settingsButton.click();
 expect(await settingsButton.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
 await page.keyboard.press('Tab');
 await expect.poll(() => page.evaluate(() => getComputedStyle(document.activeElement!).outlineWidth)).toMatch(/^(?!0px$).+/);
});
async function nativeFixture(page: import('@playwright/test').Page, setupComplete = false, scenario = '') {
 await page.addInitScript(({setupComplete, scenario}) => {
  const s = {settings: {saveRoot:'/Users/test/Pictures/archive',album:'コドモン',people:[],photosLibrary:'',importPhotos:false,sendMode:'review',miteneEnabled:scenario.startsWith('send'),miteneScope:'家族みんなに公開',autoSync:true,launchAtLogin:false,initialStartDate:'2000-01-01',faceMinPx:50,faceMinRatio:.08,faceMainRatio:.6,faceMaxPeople:scenario === 'zero-people' ? 0 : 5,syncTimes:['17:30','21:00'],faceTimes:['07:00','13:00','19:00','22:00'],setupComplete},photos:scenario.startsWith('send') || scenario === 'validation' ? [{id:'recovery-photo',filename:'recovery.jpg',path:'',date:'2026-10-02',title:'Recovery',postId:'',decision:'include',autoSelected:true,reason:'',uploadState:scenario === 'send-uncertain' ? 'uncertain' : 'pending',imported:false,importError:null,sentAt:null}] : [],posts:[{id:'unsafe',date:'2026-10-02',kind:'お知らせ',title:'安全な記録表示',body:'<img src=x onerror="window.UNSAFE=true"> 園からのお知らせ',path:'',attachments:[]}],jobs:scenario === 'login-error' || scenario.startsWith('send') ? [{id:1,kind:scenario === 'login-error' ? 'コドモンにログイン' : 'みてねへ送信',startedAt:'2026-10-02T08:00:00Z',endedAt:'2026-10-02T08:01:00Z',status:'error',message:'Failed'}] : [],busy:false,progress:'',codmonConnected:setupComplete,miteneConnected:false,platform:'darwin',demo:false,validation:scenario === 'validation',update:null};
  const callbacks: ((s: unknown) => void)[] = [];
  Object.assign(window, {desktop: {snapshot:async()=>structuredClone(s),onChange:(cb:(s:unknown)=>void)=>{callbacks.push(cb);return()=>{};},action:async(a:{type:string,provider?:string,settings?:typeof s.settings})=>{
   Object.assign(window, {lastAction: a});
   if(a.type === 'settings' && scenario === 'slow-settings') await new Promise(resolve => setTimeout(resolve, 700));
   if(a.type === 'sync' && scenario !== 'period') throw new Error('接続に失敗しました。再ログインしてください。');
   if(a.type === 'chooseFolder') return {path:'/Users/test/Pictures/おむかえフォト'};
   if(a.type === 'login') {s.codmonConnected=true;callbacks.forEach(cb=>cb(structuredClone(s)));}
   if(a.type === 'settings') s.settings = a.settings!;
   return structuredClone(s);
  }}});
 }, {setupComplete, scenario});
}
test('native onboarding keeps draft across login, chooses folder and reports failures', async ({page}) => {
 await nativeFixture(page); await page.goto('/');
 await expect(page.getByText('体験用のデモです', {exact:false})).toHaveCount(0);
 await expect(page.getByRole('heading', {name:'はじめの設定'})).toBeVisible();
 await page.locator('[data-time-list="sync"] input').first().fill('16:45');
 await expect(page.getByLabel('子どもの名前')).toBeHidden();
 await page.getByLabel('Macの「写真」アプリに取り込む').check();
 await page.getByLabel('子どもの名前').fill('テストの名前');
 await page.getByRole('button', {name:'コドモンにログイン',exact:true}).click();
 await expect(page.getByLabel('子どもの名前')).toHaveValue('テストの名前');
 await expect(page.locator('[data-time-list="sync"] input').first()).toHaveValue('16:45');
 await page.getByRole('button', {name:'フォルダを選ぶ',exact:true}).click();
 await expect(page.getByLabel('写真・記録の保存先')).toHaveValue('/Users/test/Pictures/おむかえフォト');
 await expect(page.locator('[data-time-list="sync"] input').first()).toHaveValue('16:45');
 await page.getByRole('button', {name:'はじめる',exact:true}).click();
 await expect(page.getByRole('heading', {name:'まだ写真を取り込んでいません'})).toBeVisible();
 await page.getByRole('button', {name:'今すぐ同期',exact:false}).click();
 await expect(page.getByRole('alert')).toContainText('接続に失敗しました');
 await expect(page.getByRole('button', {name:'今すぐ同期',exact:false})).toBeEnabled();
});
test('post text never becomes active HTML', async ({page}) => {
 await nativeFixture(page,true); await page.goto('/');
 await page.getByRole('button', {name:'園の記録',exact:true}).click();
 await expect(page.locator('.record-body')).toContainText('<img src=x onerror=');
 await expect(page.locator('.record-body img')).toHaveCount(0);
 expect(await page.evaluate(() => 'UNSAFE' in window)).toBe(false);
});
test('visual overview, photo inspection, and keyboard navigation', async ({page}, testInfo) => {
 await page.goto('/'); await page.screenshot({path:testInfo.outputPath('overview.png'),fullPage:true});
 await page.getByRole('button', {name:'写真',exact:true}).focus(); await page.keyboard.press('Enter');
 await expect(page.getByRole('heading', {name:'写真',exact:true})).toBeVisible();
 await page.locator('[data-preview]').first().click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.locator('.full-photo')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('failed login recovery opens settings and does not start sync', async ({page}) => {
 await nativeFixture(page,true,'login-error'); await page.goto('/');
 await page.getByRole('button', {name:'ログインを確認',exact:true}).click();
 await expect(page.getByRole('button', {name:'コドモンにログインし直す',exact:true})).toBeVisible();
 expect(await page.evaluate(() => 'lastAction' in window)).toBe(false);
});
for(const scenario of ['send-pending','send-uncertain']) test(`send failure recovers to ${scenario}`, async ({page}) => {
 await nativeFixture(page,true,scenario); await page.goto('/');
 await page.getByRole('button', {name:'送信結果を確認',exact:true}).click();
 if(scenario === 'send-pending') await expect(page.getByRole('button', {name:/^送る候補/})).toHaveAttribute('aria-pressed','true');
 else await expect(page.getByRole('heading', {name:/^送信できたか確認が必要な写真/})).toBeVisible();
 await expect(page.locator('.photo-card')).toHaveCount(1);
});
test('unlimited people setting can be saved', async ({page}) => {
 await nativeFixture(page,true,'zero-people'); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
});
test('schedule times autosave and reappear when settings are reopened', async ({page}) => {
 await nativeFixture(page,true); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('Macの「写真」アプリに取り込む').check(); await page.getByText('詳細設定（通常は変更不要）').click();
 const sync = page.locator('[data-time-list="sync"] input');
 const face = page.locator('[data-time-list="face"] input');
 await expect(sync).toHaveCount(2); await expect(face).toHaveCount(4);
 await sync.first().fill('21:30'); await face.nth(3).fill('23:30');
 await expect.poll(() => page.evaluate(() => (window as unknown as {lastAction?:{settings?:{syncTimes:string[];faceTimes:string[]}}}).lastAction?.settings?.syncTimes?.join(', '))).toBe('21:00, 21:30');
 await expect.poll(() => page.evaluate(() => (window as unknown as {lastAction?:{settings?:{syncTimes:string[];faceTimes:string[]}}}).lastAction?.settings?.faceTimes?.join(', '))).toBe('07:00, 13:00, 19:00, 23:30');
 await page.getByRole('button', {name:'ホーム',exact:true}).click(); await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.locator('[data-time-list="sync"] input').nth(0)).toHaveValue('21:00');
 await expect(page.locator('[data-time-list="sync"] input').nth(1)).toHaveValue('21:30');
 await expect(page.locator('[data-time-list="face"] input').nth(0)).toHaveValue('07:00');
 await expect(page.locator('[data-time-list="face"] input').nth(3)).toHaveValue('23:30');
 await expect(page.locator('[data-add-time="sync"]')).toBeDisabled();
});
test('schedule times reject duplicates without sending invalid settings', async ({page}) => {
 await nativeFixture(page,true); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 const sync = page.locator('[data-time-list="sync"] input');
 await expect(page.locator('[data-add-time="sync"]')).toBeDisabled();
 await sync.first().fill('18:00'); await sync.nth(1).fill('18:00');
 await expect(page.locator('#settings-save-state')).toContainText('同じ時刻が2つあります');
 const last = await page.evaluate(() => (window as unknown as {lastAction?:{settings?:{syncTimes:string[]}}}).lastAction?.settings?.syncTimes);
 expect(!last || new Set(last).size === last.length).toBe(true);
});
test('rapid schedule edits save the latest value after a slow earlier response', async ({page}) => {
 await nativeFixture(page,true,'slow-settings'); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 const first = page.locator('[data-time-list="sync"] input').first();
 await first.fill('16:10'); await first.fill('15:25');
 await expect.poll(() => page.evaluate(() => (window as unknown as {lastAction?:{settings?:{syncTimes:string[]}}}).lastAction?.settings?.syncTimes?.[0]), {timeout:5000}).toBe('15:25');
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
});
test('historical retry validates range and sends explicit date bounds', async ({page}) => {
 await nativeFixture(page,true,'period'); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('開始日',{exact:true}).fill('2026-09-02');
 await page.getByLabel('終了日',{exact:true}).fill('2026-09-01');
 await page.getByRole('button', {name:'この期間を取り込む',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('終了日には、開始日と同じ日');
 await page.getByLabel('終了日',{exact:true}).fill('2026-09-30');
 await page.getByRole('button', {name:'この期間を取り込む',exact:true}).click();
 expect(await page.evaluate(() => (window as unknown as {lastAction:unknown}).lastAction)).toEqual({type:'sync',startDate:'2026-09-02',endDate:'2026-09-30'});
});
test('turning off sharing keeps the active candidate tab and photos consistent', async ({page}) => {
 await page.goto('/');
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await page.getByRole('button', {name:/^送る候補/}).click();
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('みてねへの送信を使う').uncheck();
 await expect(page.getByRole('radio', {name:/確認してから送る/})).toBeHidden();
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await expect(page.getByRole('button', {name:'まとめる写真（3枚）',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.photo-card')).toHaveCount(3);
});
test('storage-only mode uses the new name and keeps all photos inspectable', async ({page}, testInfo) => {
 await page.goto('/');
 await expect(page).toHaveTitle('おむかえフォト');
 await expect(page.getByRole('link', {name:'おむかえフォト ホーム',exact:true})).toBeVisible();
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('みてねへの送信を使う').uncheck();
 await page.locator('[data-remove-person]').first().click(); await page.locator('[data-remove-person]').first().click();
 await expect(page.getByLabel('子どもの名前')).toHaveValue('');
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(8);
 await expect(page.locator('[data-decision]')).toHaveCount(0);
 await expect(page.locator('[data-send]')).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('storage-only.png'),fullPage:true});
 await page.locator('[data-preview]').first().click();
 await expect(page.locator('.full-photo')).toBeVisible();
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:testInfo.outputPath('storage-only-narrow.png'),fullPage:true});
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('native validation distinguishes copied photos from fictional demo assets', async ({page}) => {
 await nativeFixture(page,true,'validation'); await page.goto('/');
 await expect(page.locator('.validation-banner')).toHaveText('動作確認用です。この画面から外部サービスへの接続やMacの「写真」アプリの変更は行いません。');
 await expect(page.getByText('体験用のデモです', {exact:false})).toHaveCount(0);
 await expect(page.getByText('写真と記録は架空', {exact:false})).toHaveCount(0);
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await expect(page.locator('.photo-card img')).toHaveAttribute('src','codomon-photo://photo/recovery-photo');
 await page.locator('[data-preview]').first().click();
 await expect(page.locator('.full-photo')).toHaveAttribute('src','codomon-photo://photo/recovery-photo');
});

test('newly added time rows can be removed and invalid drafts survive navigation', async ({page}) => {
 await nativeFixture(page,true); await page.goto('/'); await page.getByRole('button',{name:'設定',exact:true}).click();
 await page.locator('[data-remove-time="sync"]').last().click();
 await expect(page.locator('[data-time-list="sync"] input')).toHaveCount(1);
 await page.locator('[data-add-time="sync"]').click();
 await expect(page.locator('#settings-save-state')).toContainText('未保存');
 await page.getByRole('button',{name:'ホーム',exact:true}).click(); await page.getByRole('button',{name:'設定',exact:true}).click();
 await expect(page.locator('[data-time-list="sync"] input')).toHaveCount(2);
 await expect(page.locator('[data-time-list="sync"] input').last()).toHaveValue('');
 await page.locator('[data-remove-time="sync"]').last().click();
 await expect(page.locator('[data-time-list="sync"] input')).toHaveCount(1);
 await expect(page.locator('#settings-save-state')).toHaveText('設定は保存済みです');
});
