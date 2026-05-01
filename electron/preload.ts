import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onAgentEvent: (callback: (event: any) => void) => {
    ipcRenderer.on('agent-event', (_e, data) => callback(data));
  },
  onPaneLayoutChanged: (callback: (layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) => void) => {
    const listener = (_e: IpcRendererEvent, layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) => callback(layout);
    ipcRenderer.on('pane-layout-changed', listener);
    return () => ipcRenderer.removeListener('pane-layout-changed', listener);
  },
  onConfigUpdated: (callback: (config: any) => void) => {
    const listener = (_e: IpcRendererEvent, config: any) => callback(config);
    ipcRenderer.on('config-updated', listener);
    return () => ipcRenderer.removeListener('config-updated', listener);
  },
  removeAgentEventListener: () => {
    ipcRenderer.removeAllListeners('agent-event');
  },
  startAgent: () => ipcRenderer.send('agent-start'),
  stopAgent: () => ipcRenderer.send('agent-stop'),
  runAgentOnce: () => ipcRenderer.invoke('agent-run-once'),
  startMobilePairing: () => ipcRenderer.invoke('mobile-pair-start'),
  getMobileServiceInfo: () => ipcRenderer.invoke('mobile-service-info'),
  sendCommand: (cmd: string) => ipcRenderer.send('agent-command', cmd),
  confirmPendingReply: (id: string, content: string) =>
    ipcRenderer.invoke('confirm-pending-reply', id, content),
  cancelPendingReply: (id: string) => ipcRenderer.invoke('cancel-pending-reply', id),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  listKnowledgeFiles: () => ipcRenderer.invoke('list-knowledge-files'),
  writeKnowledgeFile: (filename: string, content: string) =>
    ipcRenderer.invoke('write-knowledge-file', filename, content),
  deleteKnowledgeFile: (filename: string) =>
    ipcRenderer.invoke('delete-knowledge-file', filename),
  checkProcess: (name: string) => ipcRenderer.invoke('check-process', name),
  listOpenClawAgents: (cliPath?: string) => ipcRenderer.invoke('list-openclaw-agents', cliPath),
  setLogDrawerOpen: (open: boolean) => ipcRenderer.send('log-drawer-open', open),
  setPaneLayout: (layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) =>
    ipcRenderer.send('pane-layout', layout),
});
