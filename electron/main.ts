import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execFile } from 'child_process';
import { execSync } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentProcess: ChildProcess | null = null;
let agentOnceProcess: ChildProcess | null = null;
let autoStartTimer: NodeJS.Timeout | null = null;

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
const DEFAULT_OPENCLAW_CLI_PATH = '/opt/homebrew/bin/openclaw';

function normalizeOpenClawRoutes(routes: any) {
  return Array.isArray(routes) ? routes : [];
}

function normalizeOpenClawConfig(config: any, mode: 'customer' | 'assistant') {
  const nested = mode === 'assistant' ? config.openclaw_assistant : config.openclaw_customer;
  const legacy = {
    enabled: config.openclaw_enabled,
    cli_path: config.openclaw_cli_path,
    timeout_seconds: config.openclaw_timeout_seconds,
    extra_prompt: config.openclaw_extra_prompt,
    routes: config.openclaw_routes,
  };
  const source = nested && typeof nested === 'object' ? nested : legacy;
  return {
    enabled: source.enabled ?? false,
    cli_path: source.cli_path || DEFAULT_OPENCLAW_CLI_PATH,
    timeout_seconds: source.timeout_seconds || 120,
    extra_prompt: source.extra_prompt || '',
    routes: normalizeOpenClawRoutes(source.routes),
  };
}

function createTrayIcon() {
  const size = 16;
  const img = nativeImage.createEmpty();
  return img;
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
      mainWindow?.webContents.send('agent-event', event);
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
    mainWindow?.webContents.send('agent-event', {
      type: 'log',
      data: { level: 'error', message: data.toString() },
    });
  });

  processRef.on('error', (err) => {
    log(`${label} PROCESS ERROR: ${err}`);
    mainWindow?.webContents.send('agent-event', {
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

function startAgent() {
  if (agentProcess) return;

  console.log('[startAgent] called, isPackaged:', app.isPackaged);
  console.log('[startAgent] resourcesPath:', process.resourcesPath);

  const agentPath = getAgentPath();

  log(`agentPath: ${agentPath}`);
  log(`isPackaged: ${app.isPackaged}`);
  log(`resourcesPath: ${process.resourcesPath}`);

  try {
    agentProcess = spawn('python3', [agentPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log(`spawn succeeded, pid: ${agentProcess.pid}`);
  } catch (err) {
    log(`spawn error: ${err}`);
    mainWindow?.webContents.send('agent-event', {
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
    mainWindow?.webContents.send('agent-event', { type: 'status', data: { state: 'running' } });
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
  mainWindow?.webContents.send('agent-event', { type: 'status', data: { state: 'stopped' } });
}

function runAgentOnce(): Promise<{ ok: boolean; reason?: string }> {
  if (agentProcess) {
    return Promise.resolve({ ok: false, reason: '持续识别运行中' });
  }
  if (agentOnceProcess) {
    return Promise.resolve({ ok: false, reason: '单次识别运行中' });
  }

  const agentPath = getAgentPath();
  log(`agent once path: ${agentPath}`);

  return new Promise((resolve) => {
    try {
      agentOnceProcess = spawn('python3', [agentPath, '--once'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      log(`agent once spawn succeeded, pid: ${agentOnceProcess.pid}`);
    } catch (err) {
      log(`agent once spawn error: ${err}`);
      mainWindow?.webContents.send('agent-event', {
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

// --- IPC 处理 ---

ipcMain.on('agent-start', () => {
  console.log('[IPC] agent-start received');
  startAgent();
});
ipcMain.on('agent-stop', () => stopAgent());
ipcMain.on('agent-command', (_e, cmd: string) => {
  agentProcess?.stdin?.write(JSON.stringify({ action: cmd }) + '\n');
});
ipcMain.handle('agent-run-once', () => runAgentOnce());
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
    const nestedConfig = {
      minimax: {
        api_key: config.minimax_api_key || '',
        group_id: config.minimax_group_id || '',
        vision_model: config.minimax_vision_model || 'MiniMax-VL-01',
        text_model: config.minimax_text_model || 'MiniMax-Text-01',
      },
      feishu: {
        webhook_url: config.feishu_webhook_url || '',
      },
      wechat: {
        enabled: config.wechat_enabled ?? true,
        window_title: '微信',
      },
      wecom: {
        enabled: config.wecom_enabled ?? true,
        window_title: '企业微信',
      },
      workflow_mode: config.workflow_mode || 'customer',
      mode: config.mode || 'auto',
      escalation: {
        keywords: config.escalation_keywords || '退款,投诉,经理,报警',
        max_unsolved_rounds: config.max_unsolved_rounds || 2,
      },
      reply_delay_min: config.reply_delay_min || 1,
      reply_delay_max: config.reply_delay_max || 3,

      ocr: {
        enabled: config.ocr_enabled ?? true,
        fast_mode: config.ocr_fast_mode ?? true,
        check_interval: config.ocr_check_interval || 3,
        chat_region_mode: config.ocr_chat_region_mode || 'auto',
        chat_region: Array.isArray(config.ocr_chat_region) ? config.ocr_chat_region : [0.35, 0.0, 1.0, 1.0],
        languages: ["zh-Hans", "en"],
        trigger_keywords: config.ocr_trigger_keywords || "",
      },
      openclaw: {
        customer: normalizeOpenClawConfig(config, 'customer'),
        assistant: normalizeOpenClawConfig(config, 'assistant'),
      },

    };
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
  try {
    const result = execSync(`pgrep -xi "${name}"`, { encoding: 'utf-8' });
    return result.trim().length > 0;
  } catch {
    return false;
  }
});

// --- App 生命周期 ---

app.whenReady().then(() => {
  createWindow();
  createTray();
  // Auto-start agent for testing
  autoStartTimer = setTimeout(() => {
    autoStartTimer = null;
    startAgent();
  }, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => { stopAgent(); });
