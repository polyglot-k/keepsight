/**
 * @file The API exposed to the renderer (`window.api`). The renderer can use Node features only through the IPC calls listed here.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scan: () => ipcRenderer.invoke('scan'),
  listVersions: filePath => ipcRenderer.invoke('listVersions', filePath),
  restoreVersion: (filePath, versionPath) => ipcRenderer.invoke('restoreVersion', filePath, versionPath),
  open: filePath => ipcRenderer.invoke('open', filePath),
  editor: filePath => ipcRenderer.invoke('editor', filePath),
  reveal: filePath => ipcRenderer.invoke('reveal', filePath),
  trash: filePath => ipcRenderer.invoke('trash', filePath),
  addLink: link => ipcRenderer.invoke('addLink', link),
  updateMeta: (filePath, changes) => ipcRenderer.invoke('updateMeta', filePath, changes),
  importChromeLogin: () => ipcRenderer.invoke('importChromeLogin'),
  ensureClaudeLogin: () => ipcRenderer.invoke('ensureClaudeLogin'),
  showContextMenu: () => ipcRenderer.invoke('showContextMenu'),
  setFullScreen: enabled => ipcRenderer.invoke('setFullScreen', enabled),
  setMiniWindow: (enabled, savedBounds) => ipcRenderer.invoke('setMiniWindow', enabled, savedBounds),
  onLibraryChanged: listener => ipcRenderer.on('libraryChanged', listener),
  onZoom: listener => ipcRenderer.on('zoom', (_event, direction) => listener(direction)),
  onToggleZen: listener => ipcRenderer.on('toggleZen', listener),
  onToggleMini: listener => ipcRenderer.on('toggleMini', listener),
  onOpenPalette: listener => ipcRenderer.on('openPalette', listener),
});
