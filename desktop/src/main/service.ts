import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivePhoto, Person, Photo, Settings, Snapshot, SyncResult, FaceResult } from '../shared/types';
import { Store, archivePathAllowed, validDay, chosen } from './store';
import type { Session, ConnectorOptions } from './connectors';
import { beforeAutoSend } from '../shared/send';
export interface Vault { has(provider:string): boolean; get(provider:string): Session; put(provider:string,value:Session):void; }
export interface Connections {
  manualLogin(provider:'codmon'|'mitene',options:ConnectorOptions):Promise<Session>;
  syncCodmon(settings:Settings,session:Session,start:string,end:string,options:ConnectorOptions):Promise<SyncResult>;
  importIntoPhotos(settings:Settings,photos:ArchivePhoto[]):Promise<{imported:string[];errors:Record<string,string>}>;
  analyzePhotos(settings:Settings):Promise<FaceResult[]>;
  uploadMitene(settings:Settings,session:Session,photos:ArchivePhoto[],callbacks:{beforeSend:(ids:string[])=>void;onSent:(ids:string[])=>void},options:ConnectorOptions):Promise<void>;
  refreshMiteneSession?: (session:Session,options:ConnectorOptions)=>Promise<Session>;
  updatePersonAlbum?: (settings:Settings,person:Person,photos:ArchivePhoto[])=>Promise<void>;
}
/**
 * One child's album: photos judged to show that child, minus excluded ones. A manually included photo joins the album of
 * each child found in it at all (even too small to be chosen); with a single child it always joins.
 */
export function personPhotos(photos:Photo[],faces:FaceResult[],person:Person,count:number):Photo[]{
  const mine=faces.filter(f=>f.person===person.name),chosen=new Set(mine.filter(f=>f.selected).map(f=>f.filename)),found=new Set(mine.map(f=>f.filename));
  return photos.filter(p=>p.decision==='include'?count===1||found.has(p.filename):p.decision==='auto'&&chosen.has(p.filename));
}
export function dayNow(now=new Date()):string { return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }
export function safeError(e:unknown):string { return (e instanceof Error?e.message:'処理に失敗しました').replace(/https?:\/\/[^\s)）]+/g,'[接続先]').slice(0,1000); }
export class Service {
  busy=false; progress=''; update:Snapshot['update']=null;
  constructor(readonly store:Store,readonly vault:Vault,readonly connectors:Connections,readonly options:{version?:string;executablePath?:string;changed:()=>void;notify:(message:string)=>void;demo?:boolean;validation?:boolean}){}
  snapshot():Snapshot { return {settings:this.store.settings(),photos:this.store.photos(),posts:this.store.posts(),jobs:this.store.jobs(),busy:this.busy,progress:this.progress,codmonConnected:this.vault.has('codmon')&&!this.store.get('codmonNeedsLogin'),miteneConnected:this.vault.has('mitene')&&!this.store.get('miteneNeedsLogin'),platform:process.platform,version:this.options.version??'',demo:!!this.options.demo,validation:!!this.options.validation,update:this.update}; }
  changed():void{this.options.changed();}
  setProgress=(message:string)=>{this.progress=message;this.changed();};
  session(provider:string):Session{try{return this.vault.get(provider);}catch(e){this.store.set(provider+'NeedsLogin',true);throw e;}}
  connectorOptions(provider:string):ConnectorOptions{return {executablePath:this.options.executablePath,onProgress:this.setProgress,onSession:s=>{this.vault.put(provider,s);this.store.set(provider+'NeedsLogin',false);}};}
  async exclusive(kind:string,fn:()=>Promise<void>):Promise<void>{
    if(this.busy)throw new Error('ほかの処理を実行中です。終わってからもう一度お試しください');
    this.busy=true;this.progress='準備しています';const job=this.store.startJob(kind);this.changed();
    try{await fn();this.store.finishJob(job,null,this.progress||'完了しました');}
    catch(e){const error=safeError(e);if(error.includes('コドモンに再ログイン'))this.store.set('codmonNeedsLogin',true);if(error.includes('みてねに再ログイン'))this.store.set('miteneNeedsLogin',true);this.store.finishJob(job,error);this.options.notify(error);throw new Error(error);}
    finally{this.store.markUncertain();this.busy=false;this.progress='';this.changed();}
  }
  async login(provider:'codmon'|'mitene'):Promise<void>{await this.exclusive(provider==='codmon'?'コドモンにログイン':'みてねにログイン',async()=>{const session=await this.connectors.manualLogin(provider,this.connectorOptions(provider));this.vault.put(provider,session);this.store.set(provider+'NeedsLogin',false);this.setProgress('ログインしました');});}
  /** Count requests already made today too when upgrading from a version without a quota. */
  syncQuota(now=new Date()): {date:string; count:number} {
    const date=dayNow(now), saved=this.store.get<{date:string;count:number}>('codmonDailyQuota');
    if(saved?.date===date)return saved;
    // 記録が始まってからは、日付が変われば0回から。履歴から数え直すのは、上限のない版から上げた最初の1回だけ。
    if(saved){const quota={date,count:0};this.store.set('codmonDailyQuota',quota);return quota;}
    const rows=this.store.db.prepare("SELECT startedAt FROM jobs WHERE kind='写真・記録を取得'").all();
    const count=rows.filter(row=>dayNow(new Date(String(row.startedAt)))===date).length;
    const quota={date,count};this.store.set('codmonDailyQuota',quota);return quota;
  }
  async sync(startDate?:string,endDate?:string,now=new Date()):Promise<void>{
    if(this.busy)throw new Error('ほかの処理を実行中です。終わってからもう一度お試しください');
    // Initialize before startJob so the current attempt is not counted twice.
    const quota=this.syncQuota(now);
    if(quota.count>=2)throw new Error('コドモンからの取り込みは1日2回までです。今日はもう取り込めません。明日もう一度お試しください。');
    await this.exclusive('写真・記録を取得',async()=>{
      const settings=this.store.settings();
      const end=endDate||dayNow(now);
      const last=this.store.get<string>('lastSync');
      const recent=new Date(now);recent.setDate(recent.getDate()-30);
      const pending=this.store.get<{start:string;end:string}>('pendingSync');
      const overlap = last ? new Date(last) : null;
      if(overlap) overlap.setDate(overlap.getDate()-1);
      const catchup = overlap && Number.isFinite(overlap.getTime()) && dayNow(overlap)<dayNow(recent) ? dayNow(overlap) : dayNow(recent);
      const requestedStart=startDate || (last?catchup:settings.initialStartDate);
      const start=pending&&pending.start<requestedStart?pending.start:requestedStart;
      const until=pending&&pending.end>end?pending.end:end;
      if(!validDay(start)||!validDay(until)||start>until)throw new Error('取得期間が正しくありません');
      const session=this.session('codmon');
      this.store.set('pendingSync',{start,end:until});
      // Reserve before contacting コドモン. Network failures also consume a request; restarts keep the count.
      this.store.set('codmonDailyQuota',{date:quota.date,count:quota.count+1});
      const result=await this.connectors.syncCodmon(settings,session,start,until,this.connectorOptions('codmon'));
      this.store.ingest(result.photos,result.posts);
      if(!result.errors.length){if(!startDate&&!endDate)this.store.set('lastSync',new Date().toISOString());this.store.set('pendingSync',null);}
      const errors=[...result.errors];
      let analyzed=true;
      try{errors.push(...await this.analyzeInternal());}catch(e){analyzed=false;errors.push(safeError(e));}
      // Per-photo acquisition/import warnings never block already selected photos. Failed face analysis does.
      if(analyzed&&settings.sendMode==='automatic'&&settings.miteneEnabled)await this.sendInternal();
      if(errors.length)throw new Error(`${result.photos.length}枚の写真・${result.posts.length}件の記録を確認しました。一部に問題があります：${errors.slice(0,5).join(' / ')}`);
      this.setProgress(`${result.photos.length}枚の写真・${result.posts.length}件の記録を確認しました`);
    });
  }
  async analyze():Promise<void>{await this.exclusive('候補を更新',async()=>{
    const before=this.store.photos(), selectedBefore=new Set(before.filter(chosen).map(p=>p.id));
    const sentBefore=new Set(before.filter(p=>p.uploadState==='sent').map(p=>p.id));
    const warnings=await this.analyzeInternal();const s=this.store.settings();
    if(s.sendMode==='automatic'&&s.miteneEnabled)await this.sendInternal();
    if(warnings.length)throw new Error(warnings.join(' / '));
    const after=this.store.photos(), selectedAfter=new Set(after.filter(chosen).map(p=>p.id));
    const added=[...selectedAfter].filter(id=>!selectedBefore.has(id)).length;
    const removed=[...selectedBefore].filter(id=>!selectedAfter.has(id)).length;
    const sent=after.filter(p=>p.uploadState==='sent'&&!sentBefore.has(p.id)).length;
    const summary=!s.people.length ? '顔認識を使う子どもは設定されていません。' : added||removed
      ? `写真の選択を更新しました（追加${added}枚・解除${removed}枚）。`
      : '顔認識を更新しました（選択中の写真に変更はありません）。';
    this.setProgress(summary+(sent ? ` みてねに${sent}枚送信しました。` : ''));
  });}
  async analyzeInternal():Promise<string[]>{
    const s=this.store.settings();const errors:string[]=[];
    if(s.importPhotos){
      const pending=this.store.photos().filter(p=>!p.imported);
      if(pending.length){this.setProgress('Macの「写真」アプリに取り込んでいます');const result=await this.connectors.importIntoPhotos(s,pending);this.store.markImported(result.imported,result.errors);if(Object.keys(result.errors).length)errors.push(`${Object.keys(result.errors).length}枚は、「写真」アプリに取り込めたか確認できませんでした`);}
    }
    if(s.people.length){this.setProgress('Macの「写真」アプリの顔認識の結果を読み込んでいます');const faces=await this.connectors.analyzePhotos(s);this.store.applyFaces(faces);
      if(s.importPhotos&&this.connectors.updatePersonAlbum){const photos=this.store.photos().filter(p=>p.imported);for(const person of s.people){try{await this.connectors.updatePersonAlbum(s,person,personPhotos(photos,faces,person,s.people.length));}catch(e){errors.push(s.people.length>1?`${person.name}のアルバム：${safeError(e)}`:safeError(e));}}}
    }
    if(s.miteneEnabled&&this.vault.has('mitene')&&this.connectors.refreshMiteneSession&&this.store.get<string>('miteneRefresh')!==dayNow()){
      try{await this.connectors.refreshMiteneSession(this.session('mitene'),this.connectorOptions('mitene'));this.store.set('miteneRefresh',dayNow());}catch(e){errors.push(safeError(e));if(safeError(e).includes('再ログイン'))this.store.set('miteneNeedsLogin',true);}
    }
    this.changed();return errors;
  }
  async send(ids:string[]):Promise<void>{await this.exclusive('みてねへ送信',async()=>{await this.sendInternal(ids);});}
  async sendInternal(ids?:string[]):Promise<void>{
    const settings=this.store.settings();if(!settings.miteneEnabled)throw new Error('設定で「みてねへの送信を使う」をオンにしてください');
    if(ids){for(const id of ids){const p=this.store.photo(id);if(!p||p.uploadState!=='pending')throw new Error('未送信の写真だけにチェックしてください');}this.store.decide(ids,'include');}
    // 自動送信（ids なし）では、自動送信をオンにした日より前に届いた写真は送らない。
    const candidates=this.store.eligible(ids).filter(p=>ids||!beforeAutoSend(p,settings));
    // A filename is the ledger identity. Never submit two rows with the same filename in one batch.
    const photos=[...new Map(candidates.map(p=>[p.filename,p])).values()];
    if(!photos.length){this.setProgress('みてねに送る写真はありません');return;}
    for(const p of photos)if(!await archivePathAllowed(p.path,settings.saveRoot))throw new Error('送る写真が保存先に見つかりません。「コドモンから期間を指定して取り込む」で取り込み直してください');
    await this.connectors.uploadMitene(settings,this.session('mitene'),photos,{beforeSend:ids=>{this.store.markSending(ids);this.changed();},onSent:ids=>{this.store.markSent(ids);this.changed();}},this.connectorOptions('mitene'));
    this.setProgress(`${photos.length}枚をみてねへ送信しました`);
  }
  async scheduled(now=new Date()):Promise<void>{
    const s=this.store.settings();if(this.busy||!s.setupComplete||!s.autoSync||this.options.demo||this.options.validation)return;
    const date=dayNow(now);const minute=now.getHours()*60+now.getMinutes();
    // One catch-up after sleep rather than firing every missed slot at once. Attempts are separate from last success.
    const latest=(times:string[])=>times.filter(t=>Number(t.slice(0,2))*60+Number(t.slice(3))<=minute).at(-1);
    const syncSlot=latest(s.syncTimes),faceSlot=latest(s.faceTimes);
    if(syncSlot&&this.store.get<string>('syncAttempt')!==`${date} ${syncSlot}`){
      this.store.set('syncAttempt',`${date} ${syncSlot}`);
      if(this.syncQuota(now).count<2){await this.sync(undefined,undefined,now);return;}
    }
    // Previous versions stored a bare hour. Treat it as the same slot when upgrading.
    const previousFace=this.store.get<string>('faceAttempt')?.replace(/ (\d{1,2})$/,(_,h:string)=>` ${h.padStart(2,'0')}:00`);
    if(faceSlot!==undefined&&previousFace!==`${date} ${faceSlot}`){this.store.set('faceAttempt',`${date} ${faceSlot}`);await this.analyze();}
  }
}
