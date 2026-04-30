interface ElectronAPI {
  onAgentEvent: (callback: (event: any) => void) => void;
  onPaneLayoutChanged: (callback: (layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) => void) => () => void;
  removeAgentEventListener: () => void;
  startAgent: () => void;
  stopAgent: () => void;
  runAgentOnce: () => Promise<{ ok: boolean; reason?: string }>;
  startMobilePairing: () => Promise<{ code: string; expiresAt: string } | null>;
  getMobileServiceInfo: () => Promise<{ running: boolean; port: number | null }>;
  sendCommand: (cmd: string) => void;
  confirmPendingReply: (id: string, content: string) => Promise<{ ok: boolean; reason?: string }>;
  cancelPendingReply: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  loadConfig: () => Promise<any>;
  saveConfig: (config: any) => Promise<boolean>;
  listKnowledgeFiles: () => Promise<any[]>;
  writeKnowledgeFile: (filename: string, content: string) => Promise<boolean>;
  deleteKnowledgeFile: (filename: string) => Promise<boolean>;
  checkProcess: (name: string) => Promise<boolean>;
  listOpenClawAgents: (cliPath?: string) => Promise<{ id: string; name: string }[]>;
  setLogDrawerOpen: (open: boolean) => void;
  setPaneLayout: (layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
