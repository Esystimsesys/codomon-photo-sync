// View copied real data only. --test-mode blocks every external operation.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {realpath,readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join} from 'node:path';
if(!process.env.CODOMON_SHADOW_OUTPUT)throw new Error('CODOMON_SHADOW_OUTPUT is required');
const data=await realpath(process.env.CODOMON_SHADOW_OUTPUT);
const marker=JSON.parse(await readFile(join(data,'shadow-verification.json'),'utf8'));
assert.equal(marker.format,'omukae-shadow-v1');assert.equal(marker.status,'passed');
const metadata=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const executable=process.env.CODOMON_PACKAGED_EXECUTABLE||resolve(`release/mac-arm64/${metadata.build.productName}.app/Contents/MacOS/${metadata.build.productName}`);
let app;
try{
 app=await electron.launch({executablePath:executable,args:['--test-mode'],env:{...process.env,CODOMON_TEST_DATA:data,ELECTRON_RUN_AS_NODE:''},timeout:30000});
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.desktop);
 const snapshot=await page.evaluate(()=>window.desktop.snapshot());
 assert.equal(snapshot.settings.setupComplete,true);
 for(const key of ['autoSync','launchAtLogin','importPhotos','miteneEnabled'])assert.equal(snapshot.settings[key],false);
 assert.equal(snapshot.settings.sendMode,'review');assert.equal(snapshot.demo,false);assert.equal(snapshot.validation,true);
 assert.ok(snapshot.photos.length>0,'copied real photos exist');
 const archive=await realpath(snapshot.settings.saveRoot);
 const archiveRel=relative(data,archive);assert.ok(archiveRel&&!archiveRel.startsWith('..')&&!isAbsolute(archiveRel),'archive is inside isolated output');
 for(const p of [...snapshot.photos,...snapshot.posts]){
  const name=await realpath(p.path);const rel=relative(archive,name);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'all data points at copies');
 }
 assert.equal(await page.title(),metadata.build.productName);
 await page.getByRole('button',{name:'写真',exact:true}).click();
 const all=page.getByRole('button',{name:/^すべて/});if(await all.count())await all.click();
 await page.locator('[data-preview]').first().click();
 await page.locator('.full-photo').waitFor();
 assert.match(await page.locator('.full-photo').getAttribute('src'),/^codomon-photo:\/\/photo\//,'real copied image protocol, never a demo replacement');
 await page.waitForFunction(()=>{const img=document.querySelector('.full-photo');return img instanceof HTMLImageElement&&img.complete&&img.naturalWidth>0;});
 await page.keyboard.press('Escape');
 if(snapshot.posts.length){await page.getByRole('button',{name:'園の記録',exact:true}).click();await page.locator('.record-body').first().waitFor();}
 for(const type of ['sync','analyze','send','migrate']){
  const blocked=await page.evaluate(async type=>{try{await window.desktop.action({type,ids:[]});return false;}catch{return true;}},type);assert.ok(blocked,`${type} blocked`);
 }
 await app.close();app=null;
 app=await electron.launch({executablePath:executable,args:['--test-mode'],env:{...process.env,CODOMON_TEST_DATA:data,ELECTRON_RUN_AS_NODE:''},timeout:30000});
 const again=await app.firstWindow();await again.waitForFunction(()=>!!window.desktop);
 const after=await again.evaluate(()=>window.desktop.snapshot());
 assert.deepEqual(after.photos.map(p=>[p.id,p.uploadState]).sort(),snapshot.photos.map(p=>[p.id,p.uploadState]).sort());
 console.log(JSON.stringify({check:'shadow-native-ui',photos:snapshot.photos.length,records:snapshot.posts.length,imageDecoded:true,ledgerSurvivesRestart:true,externalOperationsBlocked:true}));
}finally{if(app)await app.close().catch(()=>{});}
