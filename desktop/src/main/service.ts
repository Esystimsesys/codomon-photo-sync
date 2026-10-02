import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchivePhoto, Settings, Snapshot, SyncResult, FaceResult } from '../shared/types';
import { Store, validDay } from './store';
import { archivePathAllowed, legacyJobs } from './migration';
import type { Session, ConnectorOptions } from './connectors';
export interface Vault { has(provider:string): boolean; get(provider:string): Session; put(provider:string,value:Session):void; }
export interface Connections {
  manualLogin(provider:'codmon'|'mitene',options:ConnectorOptions):Promise<Session>;
  syncCodmon(settings:Settings,session:Session,start:string,end:string,options:ConnectorOptions):Promise<SyncResult>;
  importIntoPhotos(settings:Settings,photos:ArchivePhoto[]):Promise<{imported:string[];errors:Record<string,string>}>;
  analyzePhotos(settings:Settings):Promise<FaceResult[]>;
  uploadMitene(settings:Settings,session:Session,photos:ArchivePhoto[],callbacks:{beforeSend:(ids:string[])=>void;onSent:(ids:string[])=>void},options:ConnectorOptions):Promise<void>;
  refreshMiteneSession?: (session:Session,options:ConnectorOptions)=>Promise<Session>;
  updatePersonAlbum?: (settings:Settings,photos:ArchivePhoto[])=>Promise<void>;
}
export function dayNow(now=new Date()):string { return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }
export function safeError(e:unknown):string { return (e instanceof Error?e.message:'処理に失敗しました').replace(/https?:\/\/[^\s)）]+/g,'[接続先]').slice(0,1000); }
export class Service {
  busy=false; progress=''; update:Snapshot['update']=null;
  constructor(readonly store:Store,readonly vault:Vault,readonly connectors:Connections,readonly options:{executablePath?:string;changed:()=>void;notify:(message:string)=>void;checkLegacy?:()=>Promise<void>;demo?:boolean;validation?:boolean}){}
  snapshot():Snapshot { return {settings:this.store.settings(),photos:this.store.photos(),posts:this.store.posts(),jobs:this.store.jobs(),busy:this.busy,progress:this.progress,codmonConnected:this.vault.has('codmon')&&!this.store.get('codmonNeedsLogin'),miteneConnected:this.vault.has('mitene')&&!this.store.get('miteneNeedsLogin'),platform:process.platform,demo:!!this.options.demo,validation:!!this.options.validation,update:this.update}; }
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
  async assertNoLegacy():Promise<void>{
    if(this.options.checkLegacy)return this.options.checkLegacy();
    const jobs=await legacyJobs();
    if(jobs.length)throw new Error('旧版の自動実行が登録されています。設定の「旧版（Python版）から引き継ぐ」で引き継いでから同期してください');
  }
  async login(provider:'codmon'|'mitene'):Promise<void>{await this.exclusive(provider==='codmon'?'コドモンにログイン':'みてねにログイン',async()=>{const session=await this.connectors.manualLogin(provider,this.connectorOptions(provider));this.vault.put(provider,session);this.store.set(provider+'NeedsLogin',false);this.setProgress('ログインしました');});}
  async sync(startDate?:string,endDate?:string):Promise<void>{
    await this.exclusive('写真・記録を取得',async()=>{
      await this.assertNoLegacy();
      const settings=this.store.settings();
      const end=endDate||dayNow();
      const last=this.store.get<string>('lastSync');
      const recent=new Date();recent.setDate(recent.getDate()-30);
      const pending=this.store.get<{start:string;end:string}>('pendingSync');
      const overlap = last ? new Date(last) : null;
      if(overlap) overlap.setDate(overlap.getDate()-1);
      const catchup = overlap && Number.isFinite(overlap.getTime()) && dayNow(overlap)<dayNow(recent) ? dayNow(overlap) : dayNow(recent);
      const requestedStart=startDate || (last?catchup:settings.initialStartDate);
      const start=pending&&pending.start<requestedStart?pending.start:requestedStart;
      const until=pending&&pending.end>end?pending.end:end;
      if(!validDay(start)||!validDay(until)||start>until)throw new Error('取得期間が正しくありません');
      this.store.set('pendingSync',{start,end:until});
      const result=await this.connectors.syncCodmon(settings,this.session('codmon'),start,until,this.connectorOptions('codmon'));
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
  async analyze():Promise<void>{await this.exclusive('候補を更新',async()=>{await this.assertNoLegacy();const warnings=await this.analyzeInternal();const s=this.store.settings();if(s.sendMode==='automatic'&&s.miteneEnabled)await this.sendInternal();if(warnings.length)throw new Error(warnings.join(' / '));this.setProgress('候補を更新しました');});}
  async analyzeInternal():Promise<string[]>{
    const s=this.store.settings();const errors:string[]=[];
    if(s.importPhotos){
      const pending=this.store.photos().filter(p=>!p.imported);
      if(pending.length){this.setProgress('写真.appに取り込んでいます');const result=await this.connectors.importIntoPhotos(s,pending);this.store.markImported(result.imported,result.errors);if(Object.keys(result.errors).length)errors.push(`${Object.keys(result.errors).length}枚の写真.app取り込みを確認できませんでした`);}
    }
    if(s.person){this.setProgress('写真.appの顔認識の結果を読み込んでいます');const faces=await this.connectors.analyzePhotos(s);this.store.applyFaces(faces);
      if(this.connectors.updatePersonAlbum){try{await this.connectors.updatePersonAlbum(s,this.store.photos().filter(p=>p.imported&&(p.decision==='include'||p.decision==='auto'&&p.autoSelected)));}catch(e){errors.push(safeError(e));}}
    }
    if(s.miteneEnabled&&this.vault.has('mitene')&&this.connectors.refreshMiteneSession&&this.store.get<string>('miteneRefresh')!==dayNow()){
      try{await this.connectors.refreshMiteneSession(this.session('mitene'),this.connectorOptions('mitene'));this.store.set('miteneRefresh',dayNow());}catch(e){errors.push(safeError(e));if(safeError(e).includes('再ログイン'))this.store.set('miteneNeedsLogin',true);}
    }
    this.changed();return errors;
  }
  async send(ids:string[]):Promise<void>{await this.exclusive('みてねへ送信',async()=>{await this.assertNoLegacy();await this.sendInternal(ids);});}
  async sendInternal(ids?:string[]):Promise<void>{
    const settings=this.store.settings();if(!settings.miteneEnabled)throw new Error('設定でみてね連携を有効にしてください');
    if(ids){for(const id of ids){const p=this.store.photo(id);if(!p||p.uploadState!=='pending')throw new Error('未送信の写真だけを選んでください');}this.store.decide(ids,'include');}
    const candidates=this.store.eligible(ids);
    // A filename is the legacy ledger identity. Never submit two rows with the same filename in one batch.
    const photos=[...new Map(candidates.map(p=>[p.filename,p])).values()];
    if(!photos.length){this.setProgress('送信対象はありません');return;}
    for(const p of photos)if(!await archivePathAllowed(p.path,settings.saveRoot))throw new Error('送信する写真が保存先に見つかりません。再取得してください');
    await this.connectors.uploadMitene(settings,this.session('mitene'),photos,{beforeSend:ids=>{this.store.markSending(ids);this.changed();},onSent:ids=>{this.store.markSent(ids);this.changed();}},this.connectorOptions('mitene'));
    this.setProgress(`${photos.length}枚をみてねへ送信しました`);
  }
  async scheduled(now=new Date()):Promise<void>{
    const s=this.store.settings();if(this.busy||!s.setupComplete||!s.autoSync||this.options.demo||this.options.validation)return;
    const date=dayNow(now);const minute=now.getHours()*60+now.getMinutes();
    // One catch-up after sleep rather than firing every missed slot at once. Attempts are separate from last success.
    const syncSlot=minute>=21*60?'21:00':minute>=17*60+30?'17:30':null;
    const faceSlot=[7,13,19,22].filter(h=>h*60<=minute).at(-1);
    if(syncSlot&&this.store.get<string>('syncAttempt')!==`${date} ${syncSlot}`){this.store.set('syncAttempt',`${date} ${syncSlot}`);await this.sync();}
    else if(faceSlot!==undefined&&this.store.get<string>('faceAttempt')!==`${date} ${faceSlot}`){this.store.set('faceAttempt',`${date} ${faceSlot}`);await this.analyze();}
  }
}
