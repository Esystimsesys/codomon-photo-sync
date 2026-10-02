import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ArchivePhoto, ArchivePost, Settings } from '../shared/types';
import { validDay } from './store';
const exec = promisify(execFile);
const scripts = new Set(['sync_photos.py','run_person_tasks.py','export_person.py','mitene_upload.py','healthcheck.py']);
export interface LegacyJob { label: string; path: string; directory: string; running: boolean; }
export interface Migration { directory: string; settings: Settings; photos: ArchivePhoto[]; posts: ArchivePost[]; ledger: string[]; sessions: { codmon?: unknown; mitene?: unknown }; }
function expand(s: string): string { return s.startsWith('~/') ? join(homedir(),s.slice(2)) : resolve(s); }
async function json(path: string, optional=false): Promise<any> { try { return JSON.parse(await readFile(path,'utf8')); } catch(e){ if(optional && (e as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw new Error(`${basename(path)} を読み取れません。元のファイルは変更していません。`); } }
export function legacyLedger(value: unknown): string[] { if(value===undefined) return []; if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||!x||basename(x)!==x||x.includes('\0'))) throw new Error('旧版の送信履歴が正しくありません。移行を中止しました'); return [...new Set(value)]; }
async function fingerprint(filename:string):Promise<string>{
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inspectLegacy(directory: string, current: Settings): Promise<Migration> {
  directory=await realpath(directory);
  const cfg=await json(join(directory,'config.json'));
  if(!cfg || typeof cfg!=='object' || Array.isArray(cfg)) throw new Error('旧版の設定が正しくありません');
  const root=await realpath(expand(typeof cfg.save_root==='string'?cfg.save_root:'~/Pictures/codomon'));
  const settings: Settings={...current,saveRoot:root, album:cfg.album || current.album,person:cfg.person || '',personAlbum:cfg.person_album || '',
    faceMinPx:cfg.face_min_px??25, faceMinRatio:cfg.face_min_ratio??.6, faceMainRatio:cfg.face_main_ratio??.8, faceMaxPeople:cfg.face_max_people??5,
    miteneScope:cfg.mitene_scope==='管理者のみ'?'管理者のみ':'家族みんなに公開', sendMode:'review',autoSync:false,launchAtLogin:false,setupComplete:true};
  const rawLedger=await json(join(directory,'mitene_uploaded.json'),true);
  const ledger=legacyLedger(rawLedger);
  const photos:ArchivePhoto[]=[], posts:ArchivePost[]=[];
  const filenames=new Map<string,{photo:ArchivePhoto;hash?:string}>();
  // Stable ordering keeps the earliest dated copy when identical files were archived twice.
  const days=(await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of days){
    if(!entry.isDirectory() || !(validDay(entry.name)||entry.name==='unknown-date')) continue;
    const day=join(root,entry.name);
    for(const file of await readdir(day,{withFileTypes:true})){
      if(!file.isFile()||!['.jpeg','.jpg','.png'].includes(extname(file.name).toLowerCase())) continue;
      const path=join(day,file.name);
      const previous=filenames.get(file.name);
      if(previous){
        const [before,after]=await Promise.all([stat(previous.photo.path),stat(path)]);
        let identical=false;
        if(before.size===after.size){
          previous.hash??=await fingerprint(previous.photo.path);
          identical=previous.hash===await fingerprint(path);
        }
        if(!identical) throw new Error(`同じ名前で内容が異なる写真「${file.name}」が ${previous.photo.date} と ${entry.name} にあります。元ファイルは変更していません。両方をバックアップし、どちらを引き継ぐか確認して旧版保存先の同名写真を整理してから、もう一度移行してください。`);
        continue;
      }
      const photo:ArchivePhoto={id:file.name,filename:file.name,path,date:entry.name,title:'旧版から取り込んだ写真',postId:''};
      filenames.set(file.name,{photo});photos.push(photo);
    }
    const raw=await json(join(day,'posts.json'),true);
    if(raw!==undefined && !Array.isArray(raw)) throw new Error('旧版の記録ファイルが正しくありません');
    if(raw?.length){ const md=await readFile(join(day,'記録.md'),'utf8').catch(()=> '');
      posts.push({id:`legacy:${entry.name}`,date:entry.name,kind:'記録',title:`${entry.name} の記録`,body:md,path:join(day,'記録.md'),attachments:[]}); }
  }
  const sessions={codmon:await json(join(directory,'storage_state.json'),true),mitene:await json(join(directory,'mitene_state.json'),true)};
  for(const s of Object.values(sessions)) if(s!==undefined && (!s || !Array.isArray(s.cookies) || !Array.isArray(s.origins))) throw new Error('旧版のログイン情報を読み取れません。移行後にログインし直してください');
  if(sessions.mitene!==undefined && rawLedger===undefined) throw new Error('みてねのログイン情報がありますが、旧版の送信履歴が見つかりません。二重送信を防ぐため移行を中止しました。旧版の mitene_uploaded.json を復元してから移行してください。');
  settings.miteneEnabled=!!sessions.mitene;
  return {directory,settings,photos,posts,ledger,sessions};
}
export async function legacyJobs(directory?:string):Promise<LegacyJob[]> {
  if(process.platform!=='darwin') return [];
  const root=join(homedir(),'Library/LaunchAgents');
  const result:LegacyJob[]=[];
  for(const name of await readdir(root).catch(()=>[])){
    if(!name.endsWith('.plist')) continue;
    const path=join(root,name);
    let p:any; try{p=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',path],{timeout:10000})).stdout);}catch{continue;}
    if(!Array.isArray(p.ProgramArguments)||typeof p.Label!=='string') continue;
    const script=p.ProgramArguments.find((v:unknown)=>typeof v==='string'&&isAbsolute(v)&&scripts.has(basename(v)));
    if(!script || (directory && resolve(dirname(script))!==resolve(directory))) continue;
    // Only the known app job labels, never unrelated launch agents that happen to use a similar script name.
    if(!/^com\.(?:codomon-photo-sync\.|wataru\.codomon[-.])/.test(p.Label)) continue;
    const target=`gui/${process.getuid!()}/${p.Label}`;
    let running=false, loaded=false;
    try{const output=(await exec('/bin/launchctl',['print',target],{timeout:10000})).stdout;loaded=true;running=/\bpid = \d+/.test(output);}catch{}
    let disabled=false;
    try{disabled=(await exec('/bin/launchctl',['print-disabled',`gui/${process.getuid!()}`],{timeout:10000})).stdout.includes(`"${p.Label}" => true`);}catch{}
    if(loaded || !disabled) result.push({label:p.Label,path,directory:dirname(script),running});
  }
  return result;
}
export type LegacyCommandRunner = (program: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
async function jobState(target:string, run:LegacyCommandRunner):Promise<{loaded:boolean;running:boolean}>{
  try{const {stdout}=await run('/bin/launchctl',['print',target],{timeout:10000});return {loaded:true,running:/\bpid = \d+/.test(stdout)};}
  catch(e){
    const failure=e as {code?:number|string;stderr?:string};
    // A timeout or a permission failure is not proof that a job has stopped.
    if(failure.code===113 && /Could not find (?:specified )?service|service could not be found/i.test(failure.stderr||'')) return {loaded:false,running:false};
    throw new Error('旧版の自動実行の状態を確認できませんでした。移行を中止しました。');
  }
}
export async function pauseLegacy(jobs:LegacyJob[],run:LegacyCommandRunner=exec):Promise<void>{
  if(jobs.some(j=>j.running)) throw new Error('旧版が処理中です。完了してからもう一度移行してください');
  for(const j of jobs){
    if(!/^com\.(?:codomon-photo-sync\.|wataru\.codomon[-.])[A-Za-z0-9._-]+$/.test(j.label)) throw new Error('停止対象の旧版ジョブ名が正しくありません');
    const target=`gui/${process.getuid!()}/${j.label}`;
    await run('/bin/launchctl',['disable',target],{timeout:10000});
    // The earlier inspection is stale: never boot out a job that started meanwhile.
    const current=await jobState(target,run);
    if(current.running) throw new Error('旧版が処理中です。自動起動は停止しました。現在の処理が完了してからもう一度移行してください');
    if(!current.loaded) continue;
    try{await run('/bin/launchctl',['bootout',target],{timeout:10000});}catch{/* Check the actual state, including a concurrent natural exit. */}
    if((await jobState(target,run)).loaded) throw new Error('旧版の自動実行を停止できませんでした。移行を中止しました。');
  }
}
export async function archivePathAllowed(path:string,root:string):Promise<boolean>{
  try{const [file,base]=await Promise.all([realpath(path),realpath(root)]);const rel=relative(base,file);return !!rel&&!rel.startsWith('..')&&!isAbsolute(rel)&&(await stat(file)).isFile();}catch{return false;}
}
