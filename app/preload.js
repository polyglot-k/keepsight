/**
 * @file renderer에 노출하는 API(`window.api`). Node 기능은 여기 나열한 IPC 호출로만 쓸 수 있다.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scan: () => ipcRenderer.invoke('scan'),
  open: p => ipcRenderer.invoke('open', p),
  editor: p => ipcRenderer.invoke('editor', p),
  reveal: p => ipcRenderer.invoke('reveal', p),
  trash: p => ipcRenderer.invoke('trash', p),
  addLink: a => ipcRenderer.invoke('addLink', a),
  updateMeta: (p, meta) => ipcRenderer.invoke('updateMeta', p, meta),
  importChrome: () => ipcRenderer.invoke('importChrome'),
  ensureClaudeLogin: () => ipcRenderer.invoke('ensureClaudeLogin'),
  contextMenu: () => ipcRenderer.invoke('contextMenu'),
  onChanged: fn => ipcRenderer.on('changed', fn),
  onZoom: fn => ipcRenderer.on('zoom', (_, dir) => fn(dir)),
  onZen: fn => ipcRenderer.on('zen', fn),
  fullScreen: on => ipcRenderer.invoke('fullScreen', on),
  onMini: fn => ipcRenderer.on('mini', fn),
  mini: (on, saved) => ipcRenderer.invoke('mini', on, saved),
  onPalette: fn => ipcRenderer.on('palette', fn),
  history: p => ipcRenderer.invoke('history', p),
  restore: (p, version) => ipcRenderer.invoke('restore', p, version),
});
