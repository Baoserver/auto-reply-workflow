interface ElectronAPI {
  onAgentEvent: (callback: (event: any) => void) => void;
  removeAgentEventListener: () => void;
  startAgent: () => void;
  stopAgent: () => void;
  sendCommand: (cmd: string) => void;
  loadConfig: () => Promise<any>;
  saveConfig: (config: any) => Promise<boolean>;
  listKnowledgeFiles: () => Promise<any[]>;
  writeKnowledgeFile: (filename: string, content: string) => Promise<boolean>;
  deleteKnowledgeFile: (filename: string) => Promise<boolean>;
  checkProcess: (name: string) => Promise<boolean>;
  listOpenClawAgents: () => Promise<{ id: string; name: string }[]>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
