import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({ entryPoints: ['src/main/index.ts'], outfile:'dist/main/index.cjs', bundle:true, platform:'node', format:'cjs', target:'node24', packages:'external', sourcemap:true });
await build({ entryPoints: ['src/main/preload.ts'], outfile:'dist/main/preload.cjs', bundle:true, platform:'node', format:'cjs', target:'node24', external:['electron'] });
await viteBuild();
