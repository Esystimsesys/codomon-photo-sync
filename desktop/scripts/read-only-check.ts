// Opt-in integration check. Uses existing sessions in memory; never modifies the source,
// Photos library, remote album or source session files. Temporary downloaded data is removed.
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { syncCodmon, refreshMiteneSession, analyzePhotos } from '../src/main/connectors';
import { defaults } from '../src/main/store';
import { safeError, dayNow } from '../src/main/service';
async function main(){
 const source=process.env.CODOMON_LEGACY_DIR;
 if(!source)throw new Error('CODOMON_LEGACY_DIR must identify an existing local installation');
 const root=await mkdtemp(join(tmpdir(),'codomon-readonly-'));
 try{
  const cfg=JSON.parse(await readFile(join(source,'config.json'),'utf8'));
  const settings={...defaults(),saveRoot:root,person:cfg.person||'',album:cfg.album||'コドモン',importPhotos:false};
  const folders=await readdir('browsers');const chromium=folders.find(x=>/^chromium-\d+$/.test(x));
  const executablePath=join(process.cwd(),'browsers',chromium!,`chrome-mac-${process.arch}`,'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const start=new Date();start.setDate(start.getDate()-7);
  const session=JSON.parse(await readFile(join(source,'storage_state.json'),'utf8'));
  const result=await syncCodmon(settings,session,dayNow(start),dayNow(),{executablePath});
  let rawCount=0,expectedPhotos=new Set<string>();
  for(const d of await readdir(root,{withFileTypes:true})){if(!d.isDirectory()||!(/^\d{4}-/.test(d.name)||d.name==='unknown-date'))continue;
   const records=join(root,d.name,'記録');let files:string[];try{files=await readdir(records);}catch{continue;}
   for(const file of files.filter(x=>x.endsWith('.json'))){const post=JSON.parse(await readFile(join(records,file),'utf8'));rawCount++;if(Array.isArray(post.photos))for(const p of post.photos){if(p&&typeof p.url==='string')expectedPhotos.add(new URL(p.url).pathname.split('/').at(-1)!);}}
  }
  assert.equal(result.posts.length,rawCount,'archived post count');assert.equal(new Set(result.photos.map(p=>p.filename)).size,expectedPhotos.size);
  const again=await syncCodmon(settings,session,dayNow(start),dayNow(),{executablePath});
  assert.equal(again.posts.length,result.posts.length);assert.deepEqual([...new Set(again.photos.map(p=>p.id))].sort(),[...new Set(result.photos.map(p=>p.id))].sort());
  console.log(JSON.stringify({check:'codmon-readonly',posts:result.posts.length,uniquePhotos:expectedPhotos.size,errors:result.errors.map(safeError),idempotent:true}));
  try{const ms=JSON.parse(await readFile(join(source,'mitene_state.json'),'utf8'));await refreshMiteneSession(ms,{executablePath});console.log('PASS mitene uploader available (no file selected, no upload)');}catch(e){console.log('MITENE CHECK:',safeError(e));process.exitCode=1;}
  try{const faces=await analyzePhotos(settings);console.log(JSON.stringify({check:'photos-readonly',candidates:faces.length,selected:faces.filter(p=>p.selected).length}));}catch(e){console.log('PHOTOS CHECK:',safeError(e));process.exitCode=1;}
  if(result.errors.length)process.exitCode=1;
 }finally{await rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
