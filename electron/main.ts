import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execFile } from 'child_process';
import { execSync } from 'child_process';
import { MobileControlService } from './mobileControlService';
import { buildNestedConfig, DEFAULT_OPENCLAW_CLI_PATH } from './configSerialization';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentProcess: ChildProcess | null = null;
let agentOnceProcess: ChildProcess | null = null;
let autoStartTimer: NodeJS.Timeout | null = null;
let mobileService: MobileControlService | null = null;

let LOG_FILE: string;
const DEFAULT_APP_WIDTH = 430;
const APP_HEIGHT = 900;
const DEFAULT_LOG_DRAWER_WIDTH = 390;
const MIN_APP_WIDTH = 375;
const MAX_APP_WIDTH = 760;
const MIN_LOG_DRAWER_WIDTH = 320;
const MAX_LOG_DRAWER_WIDTH = 720;
const MIN_APP_HEIGHT = 800;
let appWidth = DEFAULT_APP_WIDTH;
let logDrawerWidth = DEFAULT_LOG_DRAWER_WIDTH;
let logDrawerOpen = false;
let applyingPaneLayout = false;
let lastWindowBounds: { x: number; y: number; width: number; height: number } | null = null;
let nativeResizeSyncUntil = 0;

function log(msg: string) {
  if (!LOG_FILE) {
    try {
      LOG_FILE = path.join(app.getPath('userData'), 'app.log');
    } catch (e) {
      console.error('Failed to get userData path:', e);
      return;
    }
  }
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (e) {
    console.error('Failed to write log:', e);
  }
  console.log(logLine.trim());
}

// Determine paths based on whether app is packaged
function getConfigPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'config.yaml');
  }
  return path.join(__dirname, '../../config.yaml');
}

function getKnowledgeDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'agent', 'knowledge');
  }
  return path.join(__dirname, '../../agent/knowledge');
}

const CONFIG_PATH = getConfigPath();
const KNOWLEDGE_DIR = getKnowledgeDir();
function createTrayIcon() {
  const img = nativeImage.createFromPath(getRendererAssetPath('app-logo.png'));
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 });
}

function getRendererAssetPath(filename: string): string {
  return path.join(__dirname, '../assets', filename);
}

function emitAgentEvent(event: any) {
  mainWindow?.webContents.send('agent-event', event);
  mobileService?.ingestAgentEvent(event);
}

const PROCESS_ALIASES: Record<string, string[]> = {
  WeChat: ['WeChat', '微信'],
  微信: ['WeChat', '微信'],
  '企业微信': ['企业微信', 'WXWork', 'WeCom', 'Tencent WeWork'],
  WXWork: ['企业微信', 'WXWork', 'WeCom', 'Tencent WeWork'],
  WeCom: ['企业微信', 'WXWork', 'WeCom', 'Tencent WeWork'],
};

function isProcessRunning(name: string): boolean {
  const names = PROCESS_ALIASES[name] || [name];
  const shellEscape = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  try {
    const result = execSync(
      `osascript -e 'tell application "System Events" to get name of every process'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const processNames = result.split(',').map((item) => item.trim().toLowerCase());
    if (names.some((candidate) => processNames.includes(candidate.toLowerCase()))) return true;
  } catch {}

  for (const candidate of names) {
    try {
      const exact = execSync(`pgrep -xi ${shellEscape(candidate)}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (exact.trim().length > 0) return true;
    } catch {}
  }
  return false;
}

async function getRendererDashboardStats() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return await mainWindow.webContents.executeJavaScript(`
      (() => {
        const normalize = (value) => ({
          keywordHits: Number(value && value.keywordHits) || 0,
          visionRecognitions: Number(value && value.visionRecognitions) || 0,
          aiReplies: Number(value && value.aiReplies) || 0,
          escalations: Number(value && value.escalations) || 0,
        });
        const raw = localStorage.getItem('vision-cs-dashboard-stats');
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.day || parsed.month || parsed.year || parsed.total)) {
          return {
            day: normalize(parsed.day),
            month: normalize(parsed.month),
            year: normalize(parsed.year),
            total: normalize(parsed.total),
          };
        }
        const migrated = normalize(parsed);
        return { day: migrated, month: migrated, year: migrated, total: migrated };
      })()
    `, true);
  } catch (error) {
    log(`getRendererDashboardStats failed: ${error}`);
    return null;
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    width: appWidth,
    height: APP_HEIGHT,
    x: workArea.x + workArea.width - appWidth,
    y: workArea.y,
    minWidth: MIN_APP_WIDTH,
    minHeight: MIN_APP_HEIGHT,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F5F5F7',
    icon: getRendererAssetPath('app-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  updateWindowSizeLimits();
  lastWindowBounds = mainWindow.getBounds();
  mainWindow.on('resize', handleWindowResize);

  mainWindow.on('closed', () => {
    stopAgent();
    mainWindow = null;
    lastWindowBounds = null;
  });
}

function updateWindowSizeLimits() {
  if (!mainWindow) return;
  const minWidth = MIN_APP_WIDTH + (logDrawerOpen ? MIN_LOG_DRAWER_WIDTH : 0);
  const maxWidth = MAX_APP_WIDTH + (logDrawerOpen ? MAX_LOG_DRAWER_WIDTH : 0);
  mainWindow.setMinimumSize(minWidth, MIN_APP_HEIGHT);
  mainWindow.setMaximumSize(maxWidth, 10000);
}

function resizeMainWindow() {
  if (!mainWindow) return;
  updateWindowSizeLimits();
  const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
  const targetWidth = appWidth + (logDrawerOpen ? logDrawerWidth : 0);
  const targetHeight = Math.max(mainWindow.getBounds().height, MIN_APP_HEIGHT);
  applyingPaneLayout = true;
  mainWindow.setBounds({
    x: workArea.x + workArea.width - targetWidth,
    y: workArea.y,
    width: targetWidth,
    height: targetHeight,
  }, true);
  lastWindowBounds = mainWindow.getBounds();
  setTimeout(() => {
    applyingPaneLayout = false;
  }, 80);
}

function emitPaneLayoutChanged() {
  mainWindow?.webContents.send('pane-layout-changed', {
    mainWidth: appWidth,
    drawerWidth: logDrawerWidth,
    drawerOpen: logDrawerOpen,
  });
}

function handleWindowResize() {
  if (!mainWindow || applyingPaneLayout) return;
  const bounds = mainWindow.getBounds();
  const previous = lastWindowBounds || bounds;
  lastWindowBounds = bounds;
  nativeResizeSyncUntil = Date.now() + 350;

  if (!logDrawerOpen) {
    appWidth = Math.min(Math.max(Math.round(bounds.width), MIN_APP_WIDTH), MAX_APP_WIDTH);
    emitPaneLayoutChanged();
    return;
  }

  const previousRight = previous.x + previous.width;
  const currentRight = bounds.x + bounds.width;
  const leftDelta = bounds.x - previous.x;
  const rightDelta = currentRight - previousRight;

  if (Math.abs(leftDelta) > 2 && Math.abs(leftDelta) >= Math.abs(rightDelta)) {
    appWidth = Math.min(Math.max(Math.round(bounds.width - logDrawerWidth), MIN_APP_WIDTH), MAX_APP_WIDTH);
  } else {
    logDrawerWidth = Math.min(Math.max(Math.round(bounds.width - appWidth), MIN_LOG_DRAWER_WIDTH), MAX_LOG_DRAWER_WIDTH);
  }

  emitPaneLayoutChanged();
}

function setLogDrawerOpen(open: boolean) {
  logDrawerOpen = open;
  updateWindowSizeLimits();
  resizeMainWindow();
}

function setPaneLayout(layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) {
  const drawerOpenChanged = typeof layout.drawerOpen === 'boolean' && layout.drawerOpen !== logDrawerOpen;
  if (typeof layout.mainWidth === 'number') {
    appWidth = Math.min(Math.max(Math.round(layout.mainWidth), MIN_APP_WIDTH), MAX_APP_WIDTH);
  }
  if (typeof layout.drawerWidth === 'number') {
    logDrawerWidth = Math.min(Math.max(Math.round(layout.drawerWidth), MIN_LOG_DRAWER_WIDTH), MAX_LOG_DRAWER_WIDTH);
  }
  if (typeof layout.drawerOpen === 'boolean') {
    logDrawerOpen = layout.drawerOpen;
  }
  updateWindowSizeLimits();
  if (!drawerOpenChanged && Date.now() < nativeResizeSyncUntil) {
    lastWindowBounds = mainWindow?.getBounds() || lastWindowBounds;
    return;
  }
  resizeMainWindow();
}

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (!mainWindow) createWindow(); mainWindow?.show(); } },
    { type: 'separator' },
    { label: '开始监控', click: () => startAgent() },
    { label: '停止监控', click: () => stopAgent() },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip('视觉智能客服');
  tray.on('click', () => {
    if (!mainWindow) createWindow();
    mainWindow?.show();
  });
}

// --- Python Agent 管理 ---

function getAgentPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'agent', 'agent.py');
  }
  return path.join(__dirname, '../../agent/agent.py');
}

function getPythonPath(): string {
  const candidates = [
    process.env.VISION_CS_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3.14',
    '/usr/local/bin/python3.14',
    'python3',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (candidate === 'python3' || fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'python3';
}

function bindAgentEventStream(processRef: ChildProcess, label: string, onClose?: (code: number | null) => void) {
  let stdoutBuffer = '';
  const handleStdoutLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const logPayload = event?.type === 'openclaw'
        ? JSON.stringify({
          type: event.type,
          data: {
            agent_id: event.data?.agent_id,
            agent_name: event.data?.agent_name,
            matched_keyword: event.data?.matched_keyword,
            reply: event.data?.reply,
            stdout_length: event.data?.stdout?.length || 0,
            stderr_length: event.data?.stderr?.length || 0,
          },
        })
        : JSON.stringify(event);
      log(`AGENT EVENT: ${logPayload}`);
      emitAgentEvent(event);
    } catch (e) {
      log(`PARSE ERROR: ${line} ${e}`);
    }
  };

  processRef.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      handleStdoutLine(line);
    }
  });

  processRef.stderr?.on('data', (data: Buffer) => {
    log(`${label} STDERR: ${data.toString()}`);
    emitAgentEvent({
      type: 'log',
      data: { level: 'error', message: data.toString() },
    });
  });

  processRef.on('error', (err) => {
    log(`${label} PROCESS ERROR: ${err}`);
    emitAgentEvent({
      type: 'log',
      data: { level: 'error', message: `进程错误: ${err}` },
    });
  });

  processRef.on('close', (code) => {
    if (stdoutBuffer.trim()) {
      handleStdoutLine(stdoutBuffer);
      stdoutBuffer = '';
    }
    log(`${label} CLOSE: ${code}`);
    onClose?.(code);
  });
}

async function loadConfigForMobile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const yaml = require('js-yaml');
      return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf-8')) || {};
    }
  } catch (e) {
    log(`mobile load config failed: ${e}`);
  }
  return {};
}

async function saveConfigForMobile(config: any) {
  try {
    const yaml = require('js-yaml');
    fs.writeFileSync(CONFIG_PATH, yaml.dump(config), 'utf-8');
    if (agentProcess?.stdin?.writable) {
      agentProcess.stdin.write(JSON.stringify({ action: 'reload_config' }) + '\n');
    }
    return true;
  } catch (e) {
    log(`mobile save config failed: ${e}`);
    return false;
  }
}

function startAgent() {
  if (agentProcess) return;

  console.log('[startAgent] called, isPackaged:', app.isPackaged);
  console.log('[startAgent] resourcesPath:', process.resourcesPath);

  const agentPath = getAgentPath();
  const pythonPath = getPythonPath();

  log(`agentPath: ${agentPath}`);
  log(`pythonPath: ${pythonPath}`);
  log(`isPackaged: ${app.isPackaged}`);
  log(`resourcesPath: ${process.resourcesPath}`);

  try {
    agentProcess = spawn(pythonPath, [agentPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`spawn succeeded, pid: ${agentProcess.pid}`);
  } catch (err) {
    log(`spawn error: ${err}`);
    emitAgentEvent({
      type: 'log',
      data: { level: 'error', message: `启动失败: ${err}` },
    });
    return;
  }

  const currentProcess = agentProcess;
  bindAgentEventStream(currentProcess, 'AGENT', () => {
    if (agentProcess === currentProcess) {
      agentProcess = null;
    }
  });

  // Send initial status after a short delay to ensure window is ready
  setTimeout(() => {
    if (agentProcess !== currentProcess) return;
    log(`mainWindow exists: ${!!mainWindow}`);
    emitAgentEvent({ type: 'status', data: { state: 'running' } });
  }, 1000);
}

function stopAgent() {
  if (autoStartTimer) {
    clearTimeout(autoStartTimer);
    autoStartTimer = null;
  }
  if (!agentProcess) return;
  const processToStop = agentProcess;
  try {
    processToStop.stdin?.write(JSON.stringify({ action: 'stop' }) + '\n');
  } catch {}
  setTimeout(() => {
    if (agentProcess === processToStop) {
      processToStop.kill();
      agentProcess = null;
    }
  }, 1500);
  emitAgentEvent({ type: 'status', data: { state: 'stopped' } });
}

function runAgentOnce(): Promise<{ ok: boolean; reason?: string }> {
  if (agentProcess) {
    return Promise.resolve({ ok: false, reason: '持续识别运行中' });
  }
  if (agentOnceProcess) {
    return Promise.resolve({ ok: false, reason: '单次识别运行中' });
  }

  const agentPath = getAgentPath();
  const pythonPath = getPythonPath();
  log(`agent once path: ${agentPath}`);
  log(`agent once pythonPath: ${pythonPath}`);

  return new Promise((resolve) => {
    try {
      agentOnceProcess = spawn(pythonPath, [agentPath, '--once'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      log(`agent once spawn succeeded, pid: ${agentOnceProcess.pid}`);
    } catch (err) {
      log(`agent once spawn error: ${err}`);
      emitAgentEvent({
        type: 'log',
        data: { level: 'error', message: `单次识别启动失败: ${err}` },
      });
      resolve({ ok: false, reason: String(err) });
      return;
    }

    bindAgentEventStream(agentOnceProcess, 'AGENT ONCE', (code) => {
      agentOnceProcess = null;
      resolve({ ok: code === 0, reason: code === 0 ? undefined : `退出码 ${code}` });
    });
  });
}

function confirmPendingReply(id: string, content: string): { ok: boolean; reason?: string } {
  const targetProcess = agentProcess?.stdin?.writable ? agentProcess : agentOnceProcess;
  if (!targetProcess?.stdin?.writable) {
    return { ok: false, reason: '待确认回复已过期，请重新识别一次' };
  }
  targetProcess.stdin.write(JSON.stringify({
    action: 'confirm_pending_reply',
    id,
    content,
  }) + '\n');
  mobileService?.clearPendingReply(id);
  return { ok: true };
}

function cancelPendingReply(id: string): { ok: boolean; reason?: string } {
  const targetProcess = agentProcess?.stdin?.writable ? agentProcess : agentOnceProcess;
  if (targetProcess?.stdin?.writable) {
    targetProcess.stdin.write(JSON.stringify({
      action: 'cancel_pending_reply',
      id,
    }) + '\n');
  }
  mobileService?.clearPendingReply(id);
  return { ok: true };
}

// --- IPC 处理 ---

ipcMain.on('agent-start', () => {
  console.log('[IPC] agent-start received');
  startAgent();
});
ipcMain.on('agent-stop', () => stopAgent());
ipcMain.on('agent-command', (_e, cmd: string) => {
  agentProcess?.stdin?.write(JSON.stringify({ action: cmd }) + '\n');
});
ipcMain.handle('confirm-pending-reply', (_e, id: string, content: string) => {
  return confirmPendingReply(id, content);
});
ipcMain.handle('cancel-pending-reply', (_e, id: string) => {
  return cancelPendingReply(id);
});
ipcMain.handle('agent-run-once', () => runAgentOnce());
ipcMain.handle('mobile-pair-start', () => mobileService?.startPairing() || null);
ipcMain.handle('mobile-service-info', () => ({
  running: Boolean(mobileService),
  port: mobileService?.port || null,
}));
ipcMain.on('log-drawer-open', (_e, open: boolean) => {
  setLogDrawerOpen(open);
});
ipcMain.on('pane-layout', (_e, layout: { mainWidth?: number; drawerWidth?: number; drawerOpen?: boolean }) => {
  setPaneLayout(layout || {});
});

// 读取配置
ipcMain.handle('load-config', async () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const yaml = require('js-yaml');
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return yaml.load(content) || {};
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return {};
});

// 保存配置
ipcMain.handle('save-config', async (_e, config: any) => {
  try {
    const yaml = require('js-yaml');
    const nestedConfig = buildNestedConfig(config);
    fs.writeFileSync(CONFIG_PATH, yaml.dump(nestedConfig), 'utf-8');
    if (agentProcess?.stdin?.writable) {
      agentProcess.stdin.write(JSON.stringify({ action: 'reload_config' }) + '\n');
    }
    return true;
  } catch (e) {
    console.error('Failed to save config:', e);
    return false;
  }
});

// 列出 OpenClaw Agents
ipcMain.handle('list-openclaw-agents', async (_e, cliPath?: string) => {
  const parseJsonArray = (raw: string) => {
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
    try {
      return JSON.parse(clean);
    } catch {
      const lines = clean.split('\n');
      for (let start = 0; start < lines.length; start += 1) {
        const trimmed = lines[start].trim();
        if (trimmed !== '[' && !trimmed.startsWith('[{')) continue;
        for (let end = lines.length - 1; end >= start; end -= 1) {
          const endTrimmed = lines[end].trim();
          if (endTrimmed !== ']' && !endTrimmed.endsWith(']')) continue;
          try {
            const parsed = JSON.parse(lines.slice(start, end + 1).join('\n'));
            if (Array.isArray(parsed)) return parsed;
          } catch {}
          break;
        }
      }
      throw new Error('OpenClaw agents output is not JSON');
    }
  };
  const resolvedCliPath = cliPath?.trim() || DEFAULT_OPENCLAW_CLI_PATH;

  return new Promise((resolve) => {
    execFile(
      resolvedCliPath,
      ['agents', 'list', '--json'],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          console.error('Failed to list OpenClaw agents:', error);
          resolve([]);
          return;
        }

        try {
          const agents = parseJsonArray(stdout);
          if (!Array.isArray(agents)) {
            resolve([]);
            return;
          }
          resolve(agents.map((agent: any) => ({
            id: String(agent.id || ''),
            name: String(agent.name || agent.identityName || agent.id || ''),
          })).filter((agent: any) => agent.id));
        } catch (e) {
          console.error('Failed to parse OpenClaw agents:', e);
          resolve([]);
        }
      },
    );
  });
});

// 列出知识库文件
ipcMain.handle('list-knowledge-files', async () => {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }
    const files = fs.readdirSync(KNOWLEDGE_DIR);
    return files.map((f: string) => {
      const stats = fs.statSync(path.join(KNOWLEDGE_DIR, f));
      return { name: f, size: `${(stats.size / 1024).toFixed(1)} KB`, updatedAt: '刚刚' };
    });
  } catch (e) {
    console.error('Failed to list knowledge files:', e);
    return [];
  }
});

// 写入知识库文件
ipcMain.handle('write-knowledge-file', async (_e, filename: string, content: string) => {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(KNOWLEDGE_DIR, filename), content, 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to write knowledge file:', e);
    return false;
  }
});

// 删除知识库文件
ipcMain.handle('delete-knowledge-file', async (_e, filename: string) => {
  try {
    const filePath = path.join(KNOWLEDGE_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (e) {
    console.error('Failed to delete knowledge file:', e);
    return false;
  }
});

// 检查进程是否存在
ipcMain.handle('check-process', async (_e, name: string) => {
  return isProcessRunning(name);
});

// --- App 生命周期 ---

app.whenReady().then(() => {
  createWindow();
  createTray();
  mobileService = new MobileControlService({
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion(),
    getAgentRunning: () => Boolean(agentProcess),
    getDashboardStats: getRendererDashboardStats,
    startAgent,
    stopAgent,
    runAgentOnce,
    confirmPendingReply,
    cancelPendingReply,
    checkProcess: async (name: string) => isProcessRunning(name),
    loadConfig: loadConfigForMobile,
    saveConfig: saveConfigForMobile,
  });
  mobileService.start()
    .then(() => log(`mobile control service listening on port ${mobileService?.port}`))
    .catch((error) => log(`mobile control service failed: ${error}`));
  // Auto-start agent for testing
  autoStartTimer = setTimeout(() => {
    autoStartTimer = null;
    startAgent();
  }, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  mobileService?.stop();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => { stopAgent(); });
