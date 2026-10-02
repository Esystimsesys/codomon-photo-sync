import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const metadata=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const data=await mkdtemp(join(tmpdir(),'codomon-native-test-'));
const executable=process.env.CODOMON_PACKAGED_EXECUTABLE;
const launch=async(extra=[])=>electron.launch({...(executable?{executablePath:executable}:{}),args:[...(executable?[]:['.']),'--test-mode',...extra],env:{...process.env,CODOMON_TEST_DATA:data,ELECTRON_RUN_AS_NODE:''},timeout:30000});
let app;
try{
  app=await launch();const page=await app.firstWindow();
  await page.waitForFunction(()=>!!window.desktop);
  assert.equal(await app.evaluate(({app})=>app.getName()),metadata.name,'stable internal name for existing userData');
  assert.equal(await page.title(),metadata.build.productName,'current product name');
  let s=await page.evaluate(()=>window.desktop.snapshot());assert.equal(s.settings.setupComplete,false);assert.equal(s.settings.sendMode,'review');
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  await page.evaluate(async()=>{const s=await window.desktop.snapshot();await window.desktop.action({type:'settings',settings:{...s.settings,setupComplete:true,person:'Fixture Person',importPhotos:false}});});
  s=await page.evaluate(()=>window.desktop.snapshot());assert.equal(s.settings.person,'Fixture Person');
  const blocked=await page.evaluate(async()=>{try{await window.desktop.action({type:'sync'});return false;}catch{return true;}});assert.ok(blocked);
  await app.close();app=await launch();const again=await app.firstWindow();await again.waitForFunction(()=>!!window.desktop);
  assert.equal((await again.evaluate(()=>window.desktop.snapshot())).settings.person,'Fixture Person');
  await app.close();app=await launch(['--demo']);const demo=await app.firstWindow();await demo.waitForFunction(async()=>window.desktop&&(await window.desktop.snapshot()).photos.length===6);
  await demo.getByRole('button',{name:'写真',exact:true}).click();
  await mkdir('test-results',{recursive:true});await demo.screenshot({path:'test-results/native-desktop.png',fullPage:true});
  console.log('PASS native Electron: isolated preload, initial setup, settings persistence, demo fixtures, no external operations');
}finally{if(app)await app.close().catch(()=>{});await rm(data,{recursive:true,force:true});}
