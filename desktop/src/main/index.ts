import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, safeStorage, session, shell, Tray } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store, archivePathAllowed, validateSettings } from './store';
import { Service, type Vault, safeError } from './service';
import * as connectors from './connectors';
import type { Session } from './connectors';
import type { Action, Settings } from '../shared/types';
import { isVideo } from '../shared/media';

process.umask(0o077);
const demo = process.argv.includes('--demo');
const test = process.argv.includes('--test-mode');
if(demo || test) app.setPath('userData', process.env.CODOMON_TEST_DATA || join(tmpdir(),`codomon-desktop-${randomUUID()}`));
protocol.registerSchemesAsPrivileged([{scheme:'codomon-app',privileges:{standard:true,secure:true,supportFetchAPI:true}},{scheme:'codomon-photo',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
let window:BrowserWindow|null=null, tray:Tray|null=null, quitting=false, service:Service, store:Store;
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();
app.on('second-instance',()=>showWindow());
app.on('activate',()=>showWindow());
app.on('before-quit',()=>{quitting=true;});
app.on('window-all-closed',()=>{ /* Stay available from the menu bar. */ });

class SessionVault implements Vault {
  constructor(readonly dir:string){mkdirSync(dir,{recursive:true,mode:0o700});}
  file(provider:string):string{if(!['codmon','mitene'].includes(provider))throw new Error('ログイン先が不正です');return join(this.dir,`${provider}.enc`);}
  has(provider:string):boolean{return existsSync(this.file(provider));}
  get(provider:string):Session{
    if(!this.has(provider))throw new Error(`${provider==='codmon'?'コドモン':'みてね'}にログインしてください`);
    try{return JSON.parse(safeStorage.decryptString(readFileSync(this.file(provider))));}catch{throw new Error('ログイン情報を開けません。再ログインしてください');}
  }
  put(provider:string,value:Session):void{
    if(!safeStorage.isEncryptionAvailable())throw new Error('キーチェーンを利用できません。Macにログインし直してください');
    const file=this.file(provider),temp=file+'.part';
    writeFileSync(temp,safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});renameSync(temp,file);chmodSync(file,0o600);
  }
}
function browserExecutable():string|undefined{
  const base=app.isPackaged?join(process.resourcesPath,'browsers'):join(app.getAppPath(),'browsers');
  if(!existsSync(base))return undefined;
  for(const folder of readdirSync(base).filter(x=>/^chromium-\d+$/.test(x)).sort().reverse()){
    for(const arch of [process.arch]){
      const file=join(base,folder,`chrome-mac-${arch}`,'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      if(existsSync(file))return file;
    }
  }
  return undefined;
}
const VIDEO_PLACEHOLDER='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#d9d6cc"/><circle cx="320" cy="180" r="44" fill="#fff" opacity=".85"/><path d="M306 158 L342 180 L306 202 Z" fill="#6b6a63"/></svg>';
const ATTACHMENT_PLACEHOLDER=(type:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400"><rect width="300" height="400" fill="#f1efe6"/><path d="M70 50 H190 L240 100 V350 H70 Z" fill="#fff" stroke="#c9c5b6" stroke-width="4"/><path d="M190 50 V100 H240" fill="none" stroke="#c9c5b6" stroke-width="4"/><text x="155" y="250" text-anchor="middle" font-size="34" font-family="sans-serif" fill="#6b6a63">${type.replace(/[^A-Za-z0-9]/g,'').slice(0,5)}</text></svg>`;
/** A record's attachment, only while it is still inside the archive. */
async function attachmentPath(postId:unknown,index:unknown):Promise<string|null>{
  if(typeof postId!=='string'||!Number.isInteger(index))return null;
  const file=store.posts().find(p=>p.id===postId)?.attachments[index as number];
  return file&&await archivePathAllowed(file,store.settings().saveRoot)?file:null;
}
function notify(message:string):void {if(!demo&&!test&&Notification.isSupported())new Notification({title:'おむかえフォト',body:message}).show();}
const RELEASES='https://api.github.com/repos/Esystimsesys/codomon-photo-sync/releases/latest';
/** Only published, non-prerelease versions count. Installing stays manual because unsigned apps cannot auto-update. */
async function checkUpdate(manual:boolean):Promise<void>{
  const r=await net.fetch(RELEASES,{headers:{Accept:'application/vnd.github+json'}});
  if(r.status===404)throw new Error('公開されているアップデートはまだありません');if(!r.ok)throw new Error('更新情報を取得できませんでした');
  const data=await r.json() as {tag_name?:string;html_url?:string};const version=data.tag_name?.replace(/^v/,'');
  if(!version||!/^\d+\.\d+\.\d+$/.test(version)||!data.html_url?.startsWith('https://github.com/Esystimsesys/codomon-photo-sync/releases/'))throw new Error('更新情報の形式を確認できません');
  const current=app.getVersion().split('.').map(Number),next=version.split('.').map(Number);const diff=next.map((n,i)=>n-current[i]).find(n=>n!==0)||0;
  service.update=diff>0?{version,url:data.html_url}:null;service.changed();
  if(service.update&&store.get<string>('updateNotified')!==version){store.set('updateNotified',version);notify(`新しいバージョン ${version} があります。ホーム画面からダウンロードできます`);}
  if(!service.update&&manual)await dialog.showMessageBox({message:'お使いのバージョンは最新です',buttons:['閉じる']});
}
function changed():void{if(window&&!window.isDestroyed())window.webContents.send('changed',service.snapshot());if(tray)tray.setToolTip(service.busy?`おむかえフォト：${service.progress}`:'おむかえフォト');}
function showWindow():void {
  if(window){window.show();window.focus();return;}
  window=new BrowserWindow({width:1180,height:820,minWidth:720,minHeight:560,title:'おむかえフォト',backgroundColor:'#f7f6f1',show:false,
    webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',e=>e.preventDefault());
  window.once('ready-to-show',()=>window?.show());
  window.on('close',e=>{if(!quitting){e.preventDefault();window?.hide();}});
  window.on('closed',()=>{window=null;});
  void window.loadURL('codomon-app://app/index.html');
}
function idsFrom(value:unknown):string[]{if(!Array.isArray(value)||value.length>5000||value.some(x=>typeof x!=='string'||!x||x.length>500))throw new Error('写真の指定が正しくありません');return [...new Set(value)];}
async function confirm(message:string,detail:string,button='実行する'):Promise<boolean>{const result=await dialog.showMessageBox({type:'question',message,detail,buttons:['キャンセル',button],defaultId:0,cancelId:0});return result.response===1;}
async function saveSettings(input:unknown):Promise<void>{
  const next=validateSettings(input),before=store.settings();
  if(store.photos().length&&next.saveRoot!==before.saveRoot)throw new Error('取り込み済みの写真があるため、保存先は変更できません');
  if(!demo&&!test&&next.launchAtLogin!==before.launchAtLogin){if(!app.isPackaged&&next.launchAtLogin)throw new Error('ログイン時の起動は、アプリケーションフォルダに配置した配布版で設定してください');app.setLoginItemSettings({openAtLogin:next.launchAtLogin});}
  store.saveSettings(next);changed();
}
async function action(raw:unknown):Promise<unknown>{
  if(!raw||typeof raw!=='object'||typeof (raw as Action).type!=='string')throw new Error('操作が正しくありません');
  const a=raw as Action;
  if(service.busy)throw new Error('処理を実行中です。終わってからもう一度お試しください');
  if(demo||test){
    if(['login','sync','analyze','send','checkUpdate','openUpdate'].includes(a.type))throw new Error('デモでは、コドモン・みてねへの接続と送信は行いません');
  }
  switch(a.type){
    case 'settings':await saveSettings(a.settings);break;
    case 'login':if(!['codmon','mitene'].includes(a.provider))throw new Error('ログイン先が不正です');await service.login(a.provider);break;
    case 'sync':await service.sync(a.startDate,a.endDate);break;
    case 'analyze':await service.analyze();break;
    case 'decision':store.decide(idsFrom(a.ids),a.decision);break;
    case 'send':await service.send(idsFrom(a.ids));break;
    case 'seed':{
      const ids=idsFrom(a.ids),photos=ids.map(id=>store.photo(id));
      if(photos.some(p=>!p||p.uploadState!=='pending'))throw new Error('未送信の写真だけにチェックしてください');
      store.transaction(()=>store.seedFilenames(photos.map(p=>p!.filename),'skipped'));break;
    }
    case 'resolve':if(!['sent','retry','skipped'].includes(a.resolution))throw new Error('結果の指定が正しくありません');store.resolve(idsFrom(a.ids),a.resolution);break;
    case 'chooseFolder':{const r=await dialog.showOpenDialog({title:'写真・記録の保存先',properties:['openDirectory','createDirectory']});return r.canceled?null:{path:r.filePaths[0]};}
    case 'chooseLibrary':{const r=await dialog.showOpenDialog({title:'写真ライブラリを選ぶ',properties:['openFile','openDirectory'],filters:[{name:'写真ライブラリ',extensions:['photoslibrary','sqlite']}]});return r.canceled?null:{path:r.filePaths[0].endsWith('.photoslibrary')?join(r.filePaths[0],'database/Photos.sqlite'):r.filePaths[0]};}
    case 'openArchive':{mkdirSync(store.settings().saveRoot,{recursive:true,mode:0o700});const error=await shell.openPath(store.settings().saveRoot);if(error)throw new Error('保存先を開けませんでした');break;}
    case 'openAttachment':{const file=await attachmentPath(a.id,a.index);if(!file)throw new Error('添付ファイルが見つかりません');const err=await shell.openPath(file);if(err)throw new Error('添付ファイルを開けませんでした');break;}
    case 'openVideo':{const photo=store.photo(a.id);if(!photo||!isVideo(photo.filename)||!await archivePathAllowed(photo.path,store.settings().saveRoot))throw new Error('動画が見つかりません');const err=await shell.openPath(photo.path);if(err)throw new Error('動画を開けませんでした');break;}
    case 'openPrivacy':await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');break;
    case 'checkUpdate':await checkUpdate(true);break;
    case 'openUpdate':if(service.update)await shell.openExternal(service.update.url);break;
    case 'exportTransfer':{
      const r=await dialog.showSaveDialog({title:'移行用ファイルを書き出す',defaultPath:join(app.getPath('desktop'),`おむかえフォト-移行-${new Date().toLocaleDateString('sv-SE')}.json`),filters:[{name:'移行用ファイル',extensions:['json']}]});
      if(r.canceled||!r.filePath)return null;
      writeFileSync(r.filePath,JSON.stringify(store.exportTransfer(app.getVersion()),null,2),{mode:0o600});
      // 移した先と二重に動かないよう、このMacでの自動同期とログイン時の起動を止める。
      await saveSettings({...store.settings(),autoSync:false,launchAtLogin:false});
      changed();return {message:'移行用ファイルを書き出しました。このMacでの自動同期とログイン時の起動はオフにしました。新しいMacで読み込んでください。'};
    }
    case 'importTransfer':{
      const r=await dialog.showOpenDialog({title:'移行用ファイルを読み込む',properties:['openFile'],filters:[{name:'移行用ファイル',extensions:['json']}]});
      if(r.canceled||!r.filePaths[0])return null;
      const text=await readFile(r.filePaths[0],'utf8');
      if(text.length>50_000_000)throw new Error('移行用ファイルが大きすぎます');
      let data:unknown;try{data=JSON.parse(text);}catch{throw new Error('おむかえフォトの移行用ファイルではありません');}
      const result=store.importTransfer(data);
      const now=service.snapshot(),login=now.codmonConnected&&(!now.settings.miteneEnabled||now.miteneConnected)?'':'ログイン情報は引き継がないので、このMacでコドモン・みてねにログインしてください。';
      changed();return {message:`移行用ファイルを読み込みました。設定と、みてねに送った記録${result.ledger}件を引き継ぎました。${login}`};
    }
    default:throw new Error('対応していない操作です');
  }
  changed();return service.snapshot();
}
async function seedDemo():Promise<void>{
  const root=join(app.getPath('userData'),'sample-archive');mkdirSync(root,{recursive:true,mode:0o700});store.saveSettings({...store.settings(),saveRoot:root,importPhotos:false,people:[{name:'サンプル',album:''}],setupComplete:true});
  const colors=['#e3b59e','#a6beb0','#d8c388','#99b6ce','#b4a9c8','#dec2bb'];
  const photos=colors.map((color,i)=>{const filename=`sample-${i+1}.svg`,path=join(root,filename);writeFileSync(path,`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${color}"/><circle cx="400" cy="245" r="95" fill="#fff" opacity=".6"/><path d="M220 520 Q400 275 580 520" fill="#fff" opacity=".6"/><text x="400" y="570" text-anchor="middle" font-size="24" fill="#555">サンプル ${i+1}</text></svg>`);return {id:filename,filename,path,date:`2026-10-0${i%2+1}`,title:['お庭で遊びました','みんなで工作'][i%2],postId:`sample-post-${i%2}`};});
  store.ingest(photos,[{id:'sample-post-0',date:'2026-10-02',kind:'activities',title:'お庭で遊びました',body:'これは画面確認用のサンプルです。実際の写真・記録は使っていません。',path:'',attachments:[]}]);store.applyFaces(photos.slice(0,3).map(p=>({filename:p.filename,person:'サンプル',selected:true,reason:'顔認識で候補になりました'})));store.markSent([photos[0].id]);store.decide([photos[5].id],'exclude');
}
async function ready():Promise<void>{
  const data=app.getPath('userData');mkdirSync(data,{recursive:true,mode:0o700});chmodSync(data,0o700);
  store=new Store(join(data,'archive.sqlite'));
  const vault=new SessionVault(join(data,'sessions'));
  service=new Service(store,vault,connectors,{version:app.getVersion(),executablePath:browserExecutable(),changed,notify,demo,validation:test&&!demo});
  if(demo)await seedDemo();
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  const renderer=join(app.getAppPath(),'dist/renderer');
  protocol.handle('codomon-app',async request=>{
    try{const u=new URL(request.url);if(u.hostname!=='app')return new Response('',{status:403});const file=resolve(renderer,'.'+decodeURIComponent(u.pathname));const rel=relative(renderer,file);if(rel.startsWith('..')||isAbsolute(rel))return new Response('',{status:403});const response=await net.fetch(pathToFileURL(file).href);const headers=new Headers(response.headers);headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' codomon-photo: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");return new Response(response.body,{status:response.status,headers});}catch{return new Response('',{status:404});}
  });
  protocol.handle('codomon-photo',async request=>{
    try{const u=new URL(request.url);
      // Attachments are listed by a picture of their first page (Quick Look), or by the image itself.
      if(u.hostname==='attachment'){
        const [postId,index]=u.pathname.slice(1).split('/').map(decodeURIComponent),file=await attachmentPath(postId,Number(index));if(!file)return new Response('',{status:404});
        const ext=extname(file).slice(1).toLowerCase(),image:Record<string,string>={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp'};
        if(image[ext])return new Response(await readFile(file),{headers:{'Content-Type':image[ext],'Cache-Control':'no-store'}});
        const thumbnail=await nativeImage.createThumbnailFromPath(file,{width:480,height:480}).catch(()=>null);
        return thumbnail&&!thumbnail.isEmpty()?new Response(new Uint8Array(thumbnail.toPNG()),{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}}):new Response(ATTACHMENT_PLACEHOLDER(ext.toUpperCase()),{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}});
      }
      if(u.hostname!=='photo')return new Response('',{status:403});const photo=store.photo(decodeURIComponent(u.pathname.slice(1)));const root=store.settings().saveRoot;if(!photo||!await archivePathAllowed(photo.path,root))return new Response('',{status:404});
      // A video is listed by its thumbnail; without one, a plain placeholder keeps the grid even.
      if(isVideo(photo.filename)){const thumbnail=connectors.videoThumbnailPath(root,photo.filename);return await archivePathAllowed(thumbnail,root)?new Response(await readFile(thumbnail),{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store'}}):new Response(VIDEO_PLACEHOLDER,{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}});}
      return new Response(await readFile(photo.path),{headers:{'Content-Type':extname(photo.path)==='.svg'&&demo?'image/svg+xml':'image/jpeg','Cache-Control':'no-store'}});}catch{return new Response('',{status:404});}
  });
  const allowed=(event:Electron.IpcMainInvokeEvent)=>{if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!event.senderFrame.url.startsWith('codomon-app://app/'))throw new Error('許可されていない画面です');};
  ipcMain.handle('snapshot',event=>{allowed(event);return service.snapshot();});
  ipcMain.handle('action',async(event,payload)=>{allowed(event);try{return await action(payload);}catch(e){throw new Error(safeError(e));}});
  const icon=nativeImage.createFromPath(join(__dirname,'trayTemplate.png'));icon.setTemplateImage(true);
  tray=new Tray(icon);tray.setToolTip('おむかえフォト');tray.setContextMenu(Menu.buildFromTemplate([{label:'おむかえフォトを開く',click:showWindow},{label:'今すぐ同期',enabled:!demo&&!test,click:()=>{showWindow();void service.sync().catch(()=>{});}},{type:'separator'},{label:'終了',click:()=>app.quit()}]));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'おむかえフォト',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'unhide'},{type:'separator'},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
  showWindow();
  setInterval(()=>{void service.scheduled().catch(()=>{});},60_000).unref();
  setTimeout(()=>{void service.scheduled().catch(()=>{});},10_000).unref();
  // Check quietly after launch and once a day; network failures wait for the next check.
  if(!demo&&!test){setTimeout(()=>{void checkUpdate(false).catch(()=>{});},30_000).unref();setInterval(()=>{void checkUpdate(false).catch(()=>{});},24*60*60_000).unref();}
}
if(locked)app.whenReady().then(ready).catch(e=>{dialog.showErrorBox('おむかえフォトを起動できません',safeError(e));app.quit();});
