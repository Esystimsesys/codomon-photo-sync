import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import piexif from 'piexifjs';
import { normalizeDate, monthlyIntervals, entryDate, postedDate, timelinePhotos, recordBody, photoFilename, codmonUrl, stampExif, atomicWrite, fetchTimeline, readFaceResults, judgeFace, confirmedUploadCount, appleScriptString, syncCodmonRequest } from '../src/main/connectors';
import type { Settings } from '../src/shared/types';
const settings = { album:'園',people:[{name:'対象',album:''}],faceMinPx:25,faceMinRatio:0.6,faceMainRatio:0.8,faceMaxPeople:5 } as unknown as Settings;

test('calendar intervals are contiguous inclusive months and reject impossible dates', () => {
  assert.equal(normalizeDate('2026年8月6日'), '2026-08-06');
  assert.equal(normalizeDate('2026-02-30'), null);
  assert.equal(entryDate({ display_date:'不明',insert_datetime:'2026-08-04 12:33:00' }), '2026-08-04');
  assert.equal(entryDate({}), 'unknown-date');
  // 届いた日は、園が付けた表示日ではなく配信開始（なければ投稿）の日時から取る。
  assert.equal(postedDate({ display_date:'2026-10-08', delivery_start_datetime:'2026-10-10 09:00:00', insert_datetime:'2026-10-09 18:00:00' }), '2026-10-10');
  assert.equal(postedDate({ display_date:'2026-10-08', insert_datetime:'2026-10-09 18:00:00' }), '2026-10-09');
  assert.equal(postedDate({ display_date:'2026-10-08' }), '');
  assert.deepEqual(monthlyIntervals('2024-02-28','2024-04-01'), [['2024-02-28','2024-02-29'],['2024-03-01','2024-03-31'],['2024-04-01','2024-04-01']]);
  assert.throws(() => monthlyIntervals('2024-04-01','2024-03-01'));
});
test('sales photos are excluded; billing zero and notice body remain', () => {
  assert.deepEqual(timelinePhotos({ photos:{ lists:[{url:'https://image.codmon.com/sale.jpeg'}] } }), []);
  assert.equal(timelinePhotos({ photos:[null,{}, {url:'https://image.codmon.com/free.jpeg'}] }).length, 1);
  assert.equal(recordBody({content:'<p>販売のお知らせ<br>本文 &amp; 記録</p>'}), '販売のお知らせ\n本文 & 記録');
  assert.equal(recordBody({data:[{name:'返金',amount:0,price:200},null]}), '返金 0');
});
test('file names and remote paths cannot escape archive or attach external credentials', () => {
  assert.equal(photoFilename('https://image.codmon.com/x/%2e%2e%2fescape.jpeg?token=x'), '%2e%2e%2fescape.jpeg');
  assert.throws(() => codmonUrl('https://codmon.com.evil.test/x'));
  assert.throws(() => codmonUrl('file:///etc/passwd'));
  assert.throws(() => codmonUrl('https://user:pass@ps-api.codmon.com/x'));
  assert.equal(codmonUrl('/codmon/a.pdf'), 'https://ps-api.codmon.com/codmon/a.pdf');
  assert.equal(appleScriptString('a"\nb'), '"a\\"\\nb"');
});
test('EXIF uses source date and delivery time, refuses unknown dates/non-images', () => {
  // A JPEG marker stream suffices for lossless APP1 insertion; no image is decoded.
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xda,0,2,0xff,0xd9]);
  const stamped = stampExif(jpeg, {display_date:'2026年8月6日',delivery_start_datetime:'2026-08-06 15:03:02'});
  const result = piexif.load(stamped.toString('binary'));
  assert.equal(result.Exif[piexif.ExifIFD.DateTimeOriginal], '2026:08:06 15:03:02');
  assert.equal(piexif.load(stampExif(jpeg,{display_date:'2026-08-06'}).toString('binary')).Exif[piexif.ExifIFD.DateTimeOriginal], '2026:08:06 12:00:00');
  assert.throws(() => stampExif(jpeg, {}));
  assert.throws(() => stampExif(Buffer.from('<html>login'), {display_date:'2026-08-06'}));
});
test('atomic archive writes replace whole files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'codomon-connector-'));
  try { const p = path.join(dir,'nested','record.json'); await atomicWrite(p,'old'); await atomicWrite(p,'new'); assert.equal(await readFile(p,'utf8'),'new'); }
  finally { await rm(dir,{recursive:true,force:true}); }
});
function request(pages: any[]) {
  let calls = 0;
  return { get: async () => { const value = pages[Math.min(calls++, pages.length-1)]; return {status:()=>value.status || 200,json:async()=>value}; } } as any;
}
test('pagination returns complete results and never a partial set on failure', async () => {
  assert.deepEqual(await fetchTimeline(request([{data:[{id:1}],next_page:true},{data:[{id:2}],next_page:false}]),'s','2026-01-01','2026-01-31'),[{id:1},{id:2}]);
  for (const pages of [ [{data:[{id:1}],next_page:true},{status:500}], [{data:[],next_page:true}], [{data:[{id:1}],next_page:true}], [{data:{wrong:1}}] ]) {
    await assert.rejects(fetchTimeline(request(pages),'s','2026-01-01','2026-01-31'));
  }
});
test('face thresholds use width, reject body-only and small group rescue respects people limit', () => {
  assert.match(judgeFace(0,1,1,settings), /胴体/);
  assert.equal(judgeFace(20,0.9,5,settings),'');
  assert.notEqual(judgeFace(20,0.9,6,settings),'');
  assert.notEqual(judgeFace(53,0.49,2,settings),'');
});
test('live read-only Photos DB sees WAL, discovers join version and ignores trashed albums', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'codomon-photos-fixture-'));
  const file = path.join(dir,'Photos.sqlite');
  const writer = new DatabaseSync(file);
  try {
    writer.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE ZGENERICALBUM(Z_PK INTEGER,ZTITLE TEXT,ZTRASHEDSTATE INTEGER,ZCACHEDCOUNT INTEGER);
      CREATE TABLE Z_91ASSETS(Z_91ALBUMS INTEGER,Z_3ASSETS INTEGER,Z_FOK_3ASSETS INTEGER);
      CREATE TABLE ZADDITIONALASSETATTRIBUTES(ZASSET INTEGER,ZORIGINALFILENAME TEXT);
      CREATE TABLE ZDETECTEDFACE(ZASSETFORFACE INTEGER,ZPERSONFORFACE INTEGER,ZSIZE REAL,ZSOURCEWIDTH INTEGER,ZSOURCEHEIGHT INTEGER);
      CREATE TABLE ZPERSON(Z_PK INTEGER,ZFULLNAME TEXT);
      INSERT INTO ZGENERICALBUM VALUES(1,'園',0,1),(2,'園',1,900);
      INSERT INTO Z_91ASSETS VALUES(1,10,0),(2,20,0);
      INSERT INTO ZADDITIONALASSETATTRIBUTES VALUES(10,'portrait.jpeg'),(20,'deleted.jpeg');
      INSERT INTO ZPERSON VALUES(1,'対象'),(2,'ほか');
      INSERT INTO ZDETECTEDFACE VALUES(10,1,0.04,500,1000),(10,2,0.06,500,1000),(20,1,0.2,500,500);`);
    const reader = new DatabaseSync(file,{readOnly:true});
    try {
      let rows = readFaceResults(reader,settings);
      assert.equal(rows.length,1); assert.equal(rows[0].filename,'portrait.jpeg'); assert.equal(rows[0].selected,false);
      writer.exec('UPDATE ZDETECTEDFACE SET ZSIZE=0.07 WHERE ZASSETFORFACE=10 AND ZPERSONFORFACE=1');
      rows = readFaceResults(reader,settings); assert.equal(rows[0].selected,true);
      // Siblings are judged one by one against the same photo.
      rows = readFaceResults(reader,{...settings,people:[{name:'対象',album:''},{name:'ほか',album:''}]});
      assert.deepEqual(rows.map(r=>[r.filename,r.person,r.selected]),[['portrait.jpeg','対象',true],['portrait.jpeg','ほか',true]]);
      assert.throws(() => reader.exec('DELETE FROM ZPERSON'));
    } finally { reader.close(); }
  } finally { writer.close(); await rm(dir,{recursive:true,force:true}); }
});
test('completion requires a count and does not accept generic or partial messages', () => {
  assert.equal(confirmedUploadCount('20点のアップロードが完了しました'),20);
  assert.equal(confirmedUploadCount('アップロードが完了しました'),null);
  assert.equal(confirmedUploadCount('3点のアップロードが完了しました'),3);
  assert.equal(confirmedUploadCount('20点のアップロード中'),null);
});


test('archive preserves old records during failed month/service, all kinds, undated originals and attachment failures', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'codomon-api-fixture-'));
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xda,0,2,0xff,0xd9]);
  let phase = 0;
  const calls: string[] = [];
  const fake = {get:async(raw: string) => {
    calls.push(raw);
    const u = new URL(raw);
    let status = 200, data: any;
    if (u.pathname.endsWith('/my/')) data = {};
    else if (u.pathname.endsWith('/services/')) data = {data:{a:{},b:{}}};
    else if (u.pathname.endsWith('/timeline/')) {
      const service = u.searchParams.get('service_id'), month = u.searchParams.get('start_date');
      if (service === 'b' || (phase === 1 && month === '2026-01-01')) {status = 500; data = {};}
      else if (month === '2026-01-01') data = {data:[null, {id:1,timeline_kind:'activities',display_date:'2026-01-15',overview:'一月',photos:[{url:'https://image.codmon.com/a.jpeg'}]}, {id:2,timeline_kind:'topics',display_date:'2026-01-15',content:'写真販売',photos:{lists:[{url:'https://image.codmon.com/SALE.jpeg'}]}}, {id:3,timeline_kind:'bills',display_date:'2026-01-15',data:[{name:'請求',amount:0}],file_url:'/missing.pdf'}]};
      else data = {data:[{id:4,timeline_kind:'comments',content:'日付なし',photos:[{url:'https://image.codmon.com/unknown.jpeg'}]}]};
    } else if (u.pathname.endsWith('.pdf')) status = 500;
    return {status:()=>status,json:async()=>data,body:async()=>jpeg,headers:()=>({'content-type':'image/jpeg'})};
  }} as any;
  try {
    const s = {...settings,saveRoot:dir};
    const initial = await syncCodmonRequest(s,fake,'2026-01-01','2026-02-28');
    assert.equal(initial.posts.length,4); assert.equal(initial.photos.length,2);
    assert.equal(initial.posts.find(p=>p.kind==='bills')?.body,'請求 0');
    assert.ok(initial.errors.some(e=>e.includes('形式')));
    assert.ok(initial.errors.some(e=>e.includes('添付')));
    assert.ok(initial.errors.some(e=>e.includes('日付が分からない')));
    assert.ok(!calls.some(u=>u.includes('SALE')));
    const january = initial.posts.find(p=>p.kind==='activities')!;
    const original = await readFile(january.path,'utf8');
    const unknown = initial.photos.find(p=>p.date==='unknown-date')!;
    assert.deepEqual(await readFile(unknown.path),jpeg);
    phase = 1;
    const later = await syncCodmonRequest(s,fake,'2026-01-01','2026-02-28');
    assert.equal(later.posts.length,1);
    assert.equal(await readFile(january.path,'utf8'),original);
    assert.equal(later.photos[0].id,unknown.id);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('different source paths sharing a basename are preserved separately and flagged for review', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'codomon-collision-'));
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xda,0,2,0xff,0xd9]);
  const fake = {get:async(raw: string) => { const u = new URL(raw); return {
    status:()=>200, headers:()=>({'content-type':'image/jpeg'}),body:async()=>jpeg,
    json:async()=>u.pathname.endsWith('/services/')?{data:{s:{}}}:u.pathname.endsWith('/timeline/')?{data:[
      {id:1,display_date:'2026-01-01',photos:[{url:'https://image.codmon.com/first/same.jpeg'}]},
      {id:2,display_date:'2026-01-01',photos:[{url:'https://image.codmon.com/second/same.jpeg'}]},
    ]}:{}
  };}} as any;
  try { const result = await syncCodmonRequest({...settings,saveRoot:dir},fake,'2026-01-01','2026-01-02');
    assert.equal(result.photos.length,1); assert.equal(result.photos[0].postId,'s:unknown:1');
    assert.ok(result.errors.some(e=>e.includes('同じファイル名')));
    const {readdir} = await import('node:fs/promises');
    assert.equal((await readdir(path.join(dir,'2026-01-01','重複名の確認'))).length,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('records keep their author and the children they are about; a failed child list only drops the labels', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'codomon-children-'));
  const fake = (children: unknown) => ({get:async(raw: string) => { const u = new URL(raw); return {
    status:()=>u.pathname.endsWith('/children/')&&!children?500:200, headers:()=>({}),body:async()=>Buffer.from(''),
    json:async()=>u.pathname.endsWith('/services/')?{data:{s:{}}}:u.pathname.endsWith('/children/')?children:u.pathname.endsWith('/timeline/')?{data:[
      {id:1,timeline_kind:'comments',display_date:'2026-01-01',content:'連絡',insert_administrator_name:'担任',array_member_id:['11']},
      {id:2,timeline_kind:'activities',display_date:'2026-01-01',overview:'散歩',array_member_id:['11','22']},
    ]}:{}
  };}}) as any;
  try {
    const children = {data:[{name:'上の子',nickname:null,child_member_relations:[{member_id:'11'}]},{name:'下の子',nickname:'した',child_member_relations:[{member_id:'22'}]}]};
    const result = await syncCodmonRequest({...settings,saveRoot:dir},fake(children),'2026-01-01','2026-01-02');
    assert.deepEqual(result.posts.map(p=>p.children),[['上の子'],['上の子','した']]);
    assert.deepEqual(result.posts.map(p=>p.author),['担任',undefined]);
    assert.match(await readFile(result.posts[1].path,'utf8'),/対象: 上の子・した/);
    const unlabeled = await syncCodmonRequest({...settings,saveRoot:dir},fake(null),'2026-01-01','2026-01-02');
    assert.deepEqual(unlabeled.errors,[]); assert.deepEqual(unlabeled.posts.map(p=>p.children),[undefined,undefined]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('upload batches persist sending before click and success before next navigation; ambiguous count stops', async () => {
  const { uploadMitenePage } = await import('../src/main/connectors');
  const events: string[] = [];
  let gotoCount = 0, count = 20;
  const page = {
    goto:async()=>{events.push('navigate');gotoCount++;},url:()=> 'https://mitene.us/web/uploader',
    locator:()=>({waitFor:async()=>{},count:async()=>1,setInputFiles:async()=>events.push('files')}),
    innerText:async()=>'',
    getByRole:(_role: string,options: any)=>{assert.equal(options.exact,true);return {waitFor:async()=>{},count:async()=>1,click:async()=>events.push('click')};},
    waitForFunction:async(fn: (n:number)=>boolean, expected:number)=>{
      (globalThis as any).document = {body:{innerText:`${count}点のアップロードが完了しました`}};
      try { if (!fn(expected)) throw new Error('timeout'); } finally { delete (globalThis as any).document; }
    }
  } as any;
  const photos = Array.from({length:21},(_,i)=>({id:String(i),path:`/synthetic/${i}.jpeg`})) as any;
  const callbacks = {beforeSend:(ids:string[])=>{events.push(`sending:${ids.length}`);},onSent:(ids:string[])=>{events.push(`sent:${ids.length}`);}};
  await assert.rejects(uploadMitenePage(page,{...settings,miteneScope:'家族みんなに公開'},photos,callbacks),/送信できたか確認できません/);
  assert.equal(gotoCount,2);
  assert.deepEqual(events,['navigate','files','sending:20','click','sent:20','navigate','files','sending:1','click']);
  events.length = 0; count = 1;
  await uploadMitenePage(page,{...settings,miteneScope:'管理者のみ'},photos.slice(0,1),callbacks);
  assert.deepEqual(events,['navigate','files','sending:1','click','sent:1']);
});
test('upload rejects ambiguous scope and old completion before marking sending', async () => {
  const { uploadMitenePage } = await import('../src/main/connectors');
  let before = 0;
  const page = {goto:async()=>{},url:()=> 'https://mitene.us/web/uploader',
    locator:()=>({waitFor:async()=>{},count:async()=>1,setInputFiles:async()=>{}}),
    innerText:async()=>'',getByRole:()=>({waitFor:async()=>{},count:async()=>2})} as any;
  const callbacks = {beforeSend:()=>{before++;},onSent:()=>{assert.fail('must not confirm');}};
  await assert.rejects(uploadMitenePage(page,settings,[{id:'x',path:'/synthetic/x'}] as any,callbacks),/公開範囲/);
  page.innerText = async()=> '1点のアップロードが完了しました';
  await assert.rejects(uploadMitenePage(page,settings,[{id:'x',path:'/synthetic/x'}] as any,callbacks),/前回/);
  assert.equal(before,0);
});

test('photo source collision remains detectable across separate sync runs without storing signed query', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'codomon-persistent-source-'));
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xda,0,2,0xff,0xd9]);
  let phase = 'first';
  const fake = {get:async(raw: string) => ({status:()=>200,body:async()=>jpeg,headers:()=>({}),json:async()=>
    raw.includes('/services/')?{data:{s:{}}}:raw.includes('/timeline/')?{data:[{id:phase,display_date:'2026-01-01',photos:[{url:`https://image.codmon.com/${phase}/same.jpeg?secret=synthetic-token`}]}]}:{}
  })} as any;
  try {
    const initial = await syncCodmonRequest({...settings,saveRoot:dir},fake,'2026-01-01','2026-01-02');
    assert.equal(initial.photos.length,1);
    assert.match(await readFile(initial.posts[0].path,'utf8'),/!\[写真\]\(\.\.\/same.jpeg\)/);
    phase = 'second';
    const second = await syncCodmonRequest({...settings,saveRoot:dir},fake,'2026-01-01','2026-01-02');
    assert.equal(second.photos.length,0); assert.ok(second.errors.some(e=>e.includes('同じファイル名')));
    const { readdir } = await import('node:fs/promises');
    const sources = await readdir(path.join(dir,'.photo-sources'));
    assert.ok(!(await readFile(path.join(dir,'.photo-sources',sources[0]),'utf8')).includes('secret'));
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('long UTF-8 final attachment names fit filesystem limits, preserve extension and remain distinct', async () => {
  const { safeFilename } = await import('../src/main/connectors');
  const name = '園だより・行事予定🎒'.repeat(50);
  const first = safeFilename(`service-topics-id-${name}一.pdf`), second = safeFilename(`service-topics-id-${name}二.pdf`);
  for (const value of [first, second, photoFilename(`https://image.codmon.com/${'x'.repeat(400)}.jpeg`)]) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= 240); assert.ok(!value.includes('�'));
  }
  assert.match(first, /-[a-f0-9]{12}\.pdf$/); assert.notEqual(first, second);
  assert.equal(safeFilename('通常のお知らせ.pdf'), '通常のお知らせ.pdf');
  const root = await mkdtemp(path.join(tmpdir(),'codomon-long-name-'));
  try { await atomicWrite(path.join(root, first), 'fixture'); assert.equal(await readFile(path.join(root, first), 'utf8'), 'fixture'); }
  finally { await rm(root, {recursive:true,force:true}); }
});
test('archive saves long Japanese attachment names and long record IDs without truncating extension', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'codomon-long-archive-'));
  const fileUrl = `/codmon/${encodeURIComponent('園のお知らせ'.repeat(80)+'.pdf')}`;
  const fake = {get:async(raw:string)=>({status:()=>200,headers:()=>({'content-type':'application/pdf'}),body:async()=>Buffer.from('synthetic pdf'),json:async()=>
    raw.includes('/services/')?{data:{s:{}}}:raw.includes('/timeline/')?{data:[{id:'記録番号'.repeat(100),timeline_kind:'topics',display_date:'2026-01-01',file_url:fileUrl}]}:{}
  })} as any;
  try {
    const result = await syncCodmonRequest({...settings,saveRoot:root},fake,'2026-01-01','2026-01-02');
    assert.deepEqual(result.errors,[]); assert.equal(result.posts.length,1); assert.equal(result.posts[0].attachments.length,1);
    const attachment = result.posts[0].attachments[0];
    assert.ok(Buffer.byteLength(path.basename(attachment),'utf8')<=240); assert.ok(attachment.endsWith('.pdf'));
    assert.equal(await readFile(attachment,'utf8'),'synthetic pdf');
    assert.ok(Buffer.byteLength(path.basename(result.posts[0].path),'utf8')<=240);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('session refresh reads uploader only and stores session after logged-in validation', async () => {
  const { refreshMitenePage } = await import('../src/main/connectors');
  const events:string[] = []; let url = 'https://mitene.us/web/uploader', inputCount = 1;
  const refreshed = {cookies:[],origins:[]};
  const page = {goto:async(value:string)=>{assert.equal(value,'https://mitene.us/web/uploader');events.push('visit');},url:()=>url,
    locator:(selector:string)=>{assert.equal(selector,'input[type=file]');return {waitFor:async()=>{events.push('wait');},count:async()=>inputCount};},
    context:()=>({storageState:async()=>{events.push('read-session');return refreshed;}})} as any;
  const save = async()=>{events.push('save');};
  assert.equal(await refreshMitenePage(page,{onSession:save}),refreshed);
  assert.deepEqual(events,['visit','wait','read-session','save']);
  for(const badUrl of ['https://mitene.us/web/login','https://mitene.us/web/otp','https://mitene.us.evil.test/web/uploader']) {
    events.length = 0; url = badUrl; await assert.rejects(refreshMitenePage(page,{onSession:save}),/再ログイン/); assert.deepEqual(events,['visit']);
  }
  events.length = 0; url = 'https://mitene.us/web/uploader'; inputCount = 2;
  await assert.rejects(refreshMitenePage(page,{onSession:save}),/確認できません/);
  assert.deepEqual(events,['visit','wait']);
});

function albumFixture(options: { incomplete?: boolean; renameFailure?: boolean; finalMismatch?: boolean; unchanged?: boolean } = {}) {
  const target = '対象アルバム';
  const albums = new Map<string, Set<string>>([['園',new Set(['first.jpeg','second.jpeg'])],[target,new Set(['first.jpeg'])]]);
  const commands: string[] = [];
  let renamed = false;
  const adapter = {
    run: async (body: string) => {
      commands.push(body);
      if (body.includes('every album whose name')) return {stdout:'1,1'};
      const created = body.match(/^make new album named "([^"]+)"$/);
      if (created) { albums.set(created[1],new Set()); return {stdout:''}; }
      if (body.startsWith('set src')) {
        const dest = body.match(/add src to album "([^"]+)"/)![1];
        if (!options.incomplete) for (const match of body.matchAll(/filename is "([^"]+)"/g)) albums.get(dest)!.add(match[1]);
        return {stdout:''};
      }
      const count = body.match(/^return \(count of media items of album "([^"]+)"\)/);
      if (count) return {stdout:String(albums.get(count[1])?.size || 0)};
      const rename = body.match(/set name of album "([^"]+)" to "([^"]+)"/);
      if (rename) {
        if (options.renameFailure && rename[1].includes('更新中')) throw new Error('simulated staging rename failed');
        const current = albums.get(rename[1]);
        if (current) { albums.delete(rename[1]); albums.set(rename[2],current); }
        if (rename[1].includes('更新中')) renamed = true;
        return {stdout:''};
      }
      const deleted = body.match(/delete album "([^"]+)"/);
      if (deleted) { albums.delete(deleted[1]); return {stdout:''}; }
      throw new Error(`unexpected command ${body}`);
    },
    albumFiles: async (name: string) => options.finalMismatch && renamed && name===target ? new Set(['unexpected.jpeg']) : new Set(albums.get(name) || []),
  };
  const config = {...settings,person:{name:'対象',album:target}};
  const photos = (options.unchanged?['first.jpeg']:['second.jpeg']).map(filename=>({filename})) as any;
  return {albums,commands,adapter,config,photos,target};
}
test('person album incomplete staging never renames or deletes original album', async () => {
  const {updatePersonAlbumWith} = await import('../src/main/connectors');
  const f = albumFixture({incomplete:true});
  await assert.rejects(updatePersonAlbumWith(f.config,f.config.person,f.photos,f.adapter),/今のアルバムはそのまま残し/);
  assert.deepEqual([...f.albums.get(f.target)!],['first.jpeg']);
  assert.ok(!f.commands.some(c=>c.includes('set name of album')||c.includes('delete album')));
  assert.ok([...f.albums.keys()].some(name=>name.includes('更新中')));
});
test('person album rename failure restores original name and never deletes backup content', async () => {
  const {updatePersonAlbumWith} = await import('../src/main/connectors');
  const f = albumFixture({renameFailure:true});
  await assert.rejects(updatePersonAlbumWith(f.config,f.config.person,f.photos,f.adapter),/simulated staging/);
  assert.deepEqual([...f.albums.get(f.target)!],['first.jpeg']);
  assert.ok(!f.commands.some(c=>c.includes('delete album')));
  assert.ok(f.commands.some(c=>/更新前.*to "対象アルバム"/.test(c)));
  assert.ok([...f.albums.keys()].some(name=>name.includes('更新中')));
});
test('person album final mismatch preserves old backup and source assets', async () => {
  const {updatePersonAlbumWith} = await import('../src/main/connectors');
  const f = albumFixture({finalMismatch:true});
  await assert.rejects(updatePersonAlbumWith(f.config,f.config.person,f.photos,f.adapter),/更新したあとの確認/);
  const backup = [...f.albums.entries()].find(([name])=>name.includes('更新前'))!;
  assert.deepEqual([...backup[1]],['first.jpeg']);
  assert.ok(!f.commands.some(c=>c.includes('delete album')));
  assert.deepEqual([...f.albums.get('園')!],['first.jpeg','second.jpeg']);
});
test('empty person selection replaces album references with empty set without touching source', async () => {
  const {updatePersonAlbumWith} = await import('../src/main/connectors');
  const f = albumFixture();
  await updatePersonAlbumWith(f.config,f.config.person,[],f.adapter);
  assert.equal(f.albums.get(f.target)!.size,0);
  assert.deepEqual([...f.albums.get('園')!],['first.jpeg','second.jpeg']);
  assert.equal(f.commands.filter(c=>c.includes('delete album')).length,1);
  assert.ok(f.commands.find(c=>c.includes('delete album'))!.includes('更新前'));
  assert.ok(!f.commands.some(c=>/delete (media|every)/.test(c)));
});
test('unchanged person album performs no mutation', async () => {
  const {updatePersonAlbumWith} = await import('../src/main/connectors');
  const f = albumFixture({unchanged:true});
  await updatePersonAlbumWith(f.config,f.config.person,f.photos,f.adapter);
  assert.equal(f.commands.length,1); assert.ok(f.commands[0].startsWith('return'));
  assert.deepEqual([...f.albums.get(f.target)!],['first.jpeg']);
});
