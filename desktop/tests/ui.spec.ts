import { test, expect } from '@playwright/test';
test('demo overview is isolated and shows fixture status', async ({page}) => {
 await page.goto('/'); await expect(page.getByText('体験用のデモです', {exact:false})).toBeVisible();
 await expect(page.getByRole('heading', {name:'写真8枚と記録2件を保存しています'})).toBeVisible();
 await page.getByRole('button', {name:'園の記録', exact:true}).click();
 await expect(page.getByRole('heading', {name:'秋の色をさがしに'})).toBeVisible();
});
test('manual selection persists when switching tabs', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'写真', exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(3);
 await page.locator('[data-decision]').first().selectOption('exclude');
 await expect(page.locator('.photo-card')).toHaveCount(2);
 await page.getByRole('button', {name:/^候補外/}).click();
 await expect(page.locator('.photo-card')).toHaveCount(2);
 await expect(page.locator('[data-decision]').first()).toHaveValue('exclude');
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
 await expect(page.getByRole('heading', {name:'この条件に当てはまる写真はありません'})).toBeVisible();
});
test('review is default, automatic requires confirmation and selected send has scope', async ({page}) => {
 await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.getByRole('radio', {name:/確認してから送る/})).toBeChecked();
 await page.getByRole('button', {name:'みてねにログイン',exact:true}).click();
 await page.getByLabel('みてねへの送信を使う').check();
 await page.getByRole('radio', {name:/自動で送る/}).check();
 await page.getByRole('button', {name:'設定を保存',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('これまでに取り込んだ写真');
 await page.getByRole('button', {name:'キャンセル',exact:true}).click();
 await page.getByRole('radio', {name:/確認してから送る/}).check();
 await page.getByRole('button', {name:'設定を保存',exact:true}).click();
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await page.getByLabel('表示中の写真をすべて選ぶ').check();
 await page.getByRole('button', {name:'3枚を送信',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('公開範囲：家族みんなに公開');
 await page.getByRole('dialog').getByRole('button', {name:'3枚を送信',exact:true}).click();
 await expect(page.locator('.photo-card')).toHaveCount(0);
});
test('narrow layout stays within viewport and navigation works', async ({page}) => {
 await page.setViewportSize({width: 390,height:844}); await page.goto('/');
 await page.getByRole('button', {name:'写真',exact:true}).click();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await expect(page.getByRole('heading', {name:'設定',exact:true})).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
async function nativeFixture(page: import('@playwright/test').Page, setupComplete = false, scenario = '') {
 await page.addInitScript(({setupComplete, scenario}) => {
  const s = {settings: {saveRoot:'/Users/test/Pictures/archive',album:'コドモン',person:'',personAlbum:'',photosLibrary:'',importPhotos:false,sendMode:'review',miteneEnabled:scenario.startsWith('send'),miteneScope:'家族みんなに公開',autoSync:true,launchAtLogin:false,initialStartDate:'2000-01-01',faceMinPx:50,faceMinRatio:.08,faceMainRatio:.6,faceMaxPeople:scenario === 'zero-people' ? 0 : 5,setupComplete},photos:scenario.startsWith('send') || scenario === 'validation' ? [{id:'recovery-photo',filename:'recovery.jpg',path:'',date:'2026-10-02',title:'Recovery',postId:'',decision:'include',autoSelected:true,reason:'',uploadState:scenario === 'send-uncertain' ? 'uncertain' : 'pending',imported:false,importError:null,sentAt:null}] : [],posts:[{id:'unsafe',date:'2026-10-02',kind:'お知らせ',title:'安全な記録表示',body:'<img src=x onerror="window.UNSAFE=true"> 園からのお知らせ',path:'',attachments:[]}],jobs:scenario === 'login-error' || scenario.startsWith('send') ? [{id:1,kind:scenario === 'login-error' ? 'login' : 'send',startedAt:'2026-10-02T08:00:00Z',endedAt:'2026-10-02T08:01:00Z',status:'error',message:'Failed'}] : [],busy:false,progress:'',codmonConnected:setupComplete,miteneConnected:false,platform:'darwin',demo:false,validation:scenario === 'validation',update:null};
  const callbacks: ((s: unknown) => void)[] = [];
  Object.assign(window, {desktop: {snapshot:async()=>structuredClone(s),onChange:(cb:(s:unknown)=>void)=>{callbacks.push(cb);return()=>{};},action:async(a:{type:string,provider?:string,settings?:typeof s.settings})=>{
   Object.assign(window, {lastAction: a});
   if(a.type === 'migrate') return null;
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
 await page.getByLabel('人物の名前', {exact:false}).fill('テストの名前');
 await page.getByRole('button', {name:'コドモンにログイン',exact:true}).click();
 await expect(page.getByLabel('人物の名前', {exact:false})).toHaveValue('テストの名前');
 await page.getByRole('button', {name:'フォルダを選ぶ',exact:true}).click();
 await expect(page.getByLabel('写真・記録の保存先')).toHaveValue('/Users/test/Pictures/おむかえフォト');
 await page.getByRole('button', {name:'保存してはじめる',exact:true}).click();
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
test('migration cancellation has no success notice and retains settings draft', async ({page}) => {
 await nativeFixture(page,true); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('人物の名前', {exact:false}).fill('保存前の名前');
 await page.getByRole('button', {name:'旧版のフォルダを選ぶ',exact:true}).click();
 await expect(page.getByText('旧版から引き継ぎました。',{exact:false})).toHaveCount(0);
 await expect(page.getByLabel('人物の名前', {exact:false})).toHaveValue('保存前の名前');
});
test('failed login recovery opens settings and does not start sync', async ({page}) => {
 await nativeFixture(page,true,'login-error'); await page.goto('/');
 await page.getByRole('button', {name:'ログインを確認',exact:true}).click();
 await expect(page.getByRole('button', {name:'みてねにログイン',exact:true})).toBeVisible();
 expect(await page.evaluate(() => 'lastAction' in window)).toBe(false);
});
for(const scenario of ['send-pending','send-uncertain']) test(`send failure recovers to ${scenario}`, async ({page}) => {
 await nativeFixture(page,true,scenario); await page.goto('/');
 await page.getByRole('button', {name:'送信結果を確認',exact:true}).click();
 await expect(page.getByRole('button', {name:scenario === 'send-pending' ? /^未送信/ : /^要確認/})).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.photo-card')).toHaveCount(1);
});
test('migrated unlimited people setting can be saved', async ({page}) => {
 await nativeFixture(page,true,'zero-people'); await page.goto('/'); await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByRole('button', {name:'設定を保存',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('設定を保存しました。');
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
 await page.getByRole('button', {name:/^未送信/}).click();
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('みてねへの送信を使う').uncheck();
 await page.getByRole('button', {name:'設定を保存',exact:true}).click();
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await expect(page.getByRole('button', {name:'候補（3枚）',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.photo-card')).toHaveCount(3);
});
test('storage-only mode uses the new name and keeps all photos inspectable', async ({page}, testInfo) => {
 await page.goto('/');
 await expect(page).toHaveTitle('おむかえフォト');
 await expect(page.getByRole('link', {name:'おむかえフォト ホーム',exact:true})).toBeVisible();
 await page.getByRole('button', {name:'設定',exact:true}).click();
 await page.getByLabel('みてねへの送信を使う').uncheck();
 await page.getByLabel('人物の名前',{exact:true}).fill('');
 await page.getByRole('button', {name:'設定を保存',exact:true}).click();
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
 await expect(page.locator('.validation-banner')).toHaveText('動作確認用です。この画面から外部サービスへの接続や写真.appの変更は行いません。');
 await expect(page.getByText('体験用のデモです', {exact:false})).toHaveCount(0);
 await expect(page.getByText('写真と記録は架空', {exact:false})).toHaveCount(0);
 await page.getByRole('button', {name:'写真',exact:true}).click();
 await expect(page.locator('.photo-card img')).toHaveAttribute('src','codomon-photo://photo/recovery-photo');
 await page.locator('[data-preview]').first().click();
 await expect(page.locator('.full-photo')).toHaveAttribute('src','codomon-photo://photo/recovery-photo');
});
