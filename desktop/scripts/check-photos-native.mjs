// Read-only verification via normal macOS launch, so Full Disk Access belongs to the app.
import {build} from 'esbuild';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
const source=process.env.CODOMON_LEGACY_DIR;
if(!source)throw new Error('CODOMON_LEGACY_DIR is required');
const cfg=JSON.parse(await readFile(join(source,'config.json'),'utf8'));
await mkdir('test-results',{recursive:true});
const modulePath=resolve('test-results/photos-connector.cjs');
await build({entryPoints:['src/main/connectors.ts'],outfile:modulePath,bundle:true,platform:'node',format:'cjs',packages:'external',target:'node24'});
const data=await mkdtemp(join(tmpdir(),'codomon-native-readonly-'));
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
let socket,rpc;
try{
 await promisify(execFile)('/usr/bin/open',['-n','-g',resolve('release/mac-arm64/おむかえフォト.app'),'--env',`CODOMON_TEST_DATA=${data}`,'--args',`--inspect=127.0.0.1:${port}`,'--test-mode']);
 let endpoint;
 for(let i=0;i<60;i++){
  try{endpoint=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json())[0]?.webSocketDebuggerUrl;if(endpoint)break;}catch{}
  await new Promise(r=>setTimeout(r,250));
 }
 if(!endpoint)throw new Error('Native diagnostic inspector did not start');
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let id=0;const pending=new Map();
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
 rpc=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('Native diagnostic timeout'));},90000);pending.set(key,m=>{clearTimeout(timer);m.error?reject(new Error(m.error.message)):resolve(m.result);});socket.send(JSON.stringify({id:key,method,params}));});
 const check=async({modulePath,cfg,source})=>{
  const require=process.getBuiltinModule('node:module').createRequire(modulePath);
  const {analyzePhotos}=require(modulePath);
  const path=require('node:path'),os=require('node:os');
  const settings={person:cfg.person||'',album:cfg.album||'コドモン',photosLibrary:path.join(os.homedir(),'Pictures/Photos Library.photoslibrary/database/Photos.sqlite'),faceMinPx:cfg.face_min_px??25,faceMinRatio:cfg.face_min_ratio??.6,faceMainRatio:cfg.face_main_ratio??.8,faceMaxPeople:cfg.face_max_people??5};
  const faces=await analyzePhotos(settings);
  const exec=require('node:util').promisify(require('node:child_process').execFile);
  let parity='not-run';
  try{
   const script='import json,sys; sys.path.insert(0,sys.argv[1]); import common; cfg=common.load_config(); con=common.open_library(); print(json.dumps(common.person_photos(con,cfg["album"],cfg["person"]))); con.close()';
   const {stdout}=await exec(path.join(source,'.venv/bin/python'),['-c',script,source],{timeout:60000});
   const old=JSON.parse(stdout).sort(),next=faces.filter(x=>x.selected).map(x=>x.filename).sort();
   parity=JSON.stringify(old)===JSON.stringify(next)?'match':'DIFFERENT';
  }catch{parity='legacy-reader-unavailable';}
  return {photosRead:true,candidates:faces.length,selected:faces.filter(x=>x.selected).length,legacySelection:parity};
 };
 const response=await rpc('Runtime.evaluate',{expression:`(${check.toString()})(${JSON.stringify({modulePath,cfg,source})})`,awaitPromise:true,returnByValue:true});
 if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description||'Photos read failed');
 console.log(JSON.stringify(response.result.value));if(response.result.value.legacySelection==='DIFFERENT')process.exitCode=1;
}finally{
 if(rpc)await rpc('Runtime.evaluate',{expression:`setTimeout(()=>process.getBuiltinModule('node:module').createRequire(${JSON.stringify(modulePath)})('electron').app.exit(),100)`}).catch(()=>{});
 socket?.close();await new Promise(r=>setTimeout(r,300));await rm(data,{recursive:true,force:true});await rm(modulePath,{force:true});
}
