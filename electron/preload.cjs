const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ntkDesktop', {
  isElectron: true,
  platform: process.platform,
  saveFile: (payload) => ipcRenderer.invoke('ntk:save-file', payload),
  openDownloadsFolder: () => ipcRenderer.invoke('ntk:open-downloads'),
  setTheme: (preference, isDark) => ipcRenderer.send('ntk:set-theme', { preference, isDark }),
});
