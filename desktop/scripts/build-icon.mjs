import { chromium } from 'playwright';
import { readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const folder=(await readdir('browsers')).find(x=>/^chromium-\d+$/.test(x));
const browser=await chromium.launch({executablePath:resolve('browsers',folder,`chrome-mac-${process.arch}`,'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')});
const page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});
await page.setContent('<style>body{margin:0;background:transparent}</style>'+await readFile('build/icon.svg','utf8'));
await page.screenshot({path:'build/icon.png',omitBackground:true});
for (const scale of [1, 2]) {
 const trayPage=await browser.newPage({viewport:{width:18,height:18},deviceScaleFactor:scale});
 await trayPage.setContent('<style>body{margin:0;background:transparent}</style>'+await readFile('build/tray.svg','utf8'));
 await trayPage.screenshot({path:`build/trayTemplate${scale===2?'@2x':''}.png`,omitBackground:true});
 await trayPage.close();
}
await browser.close();
const dir='build/icon.iconset';await mkdir(dir,{recursive:true});
for(const size of [16,32,128,256,512])for(const scale of [1,2])execFileSync('/usr/bin/sips',['-z',String(size*scale),String(size*scale),'build/icon.png','--out',join(dir,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],{stdio:'ignore'});
execFileSync('/usr/bin/iconutil',['-c','icns',dir,'-o','build/icon.icns']);await rm(dir,{recursive:true,force:true});
