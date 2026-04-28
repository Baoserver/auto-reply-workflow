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
  removeAgentEventListener: () => {
    ipcRenderer.removeAllListeners('agent-event');
  },
  startAgent: () => ipcRenderer.send('agent-start'),
  stopAgent: () => ipcRenderer.send('agent-stop'),
  runAgentOnce: () => ipcRenderer.invoke('agent-run-once'),
  sendCommand: (cmd: string) => ipcRenderer.send('agent-command', cmd),
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
