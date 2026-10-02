import { contextBridge, ipcRenderer } from 'electron';
import type { Action, Snapshot } from '../shared/types';
contextBridge.exposeInMainWorld('desktop', {
  snapshot:()=>ipcRenderer.invoke('snapshot'),
  action:(action:Action)=>ipcRenderer.invoke('action', action),
  onChange:(callback:(snapshot:Snapshot)=>void)=>{
    const listener=(_event:unknown,snapshot:Snapshot)=>callback(snapshot);
    ipcRenderer.on('changed',listener);
    return ()=>ipcRenderer.removeListener('changed',listener);
  }
});
