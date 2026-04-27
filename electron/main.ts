import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess, execFile } from 'child_process';
import { execSync } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentProcess: ChildProcess | null = null;

let LOG_FILE: string;

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

function createTrayIcon() {
  const size = 16;
  const img = nativeImage.createEmpty();
  return img;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 375,
    minHeight: 800,
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

  mainWindow.on('closed', () => {
    stopAgent();
    mainWindow = null;
  });
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

function startAgent() {
  if (agentProcess) return;

  console.log('[startAgent] called, isPackaged:', app.isPackaged);
  console.log('[startAgent] resourcesPath:', process.resourcesPath);

  // Determine the correct path based on whether app is packaged
  let agentPath: string;
  if (app.isPackaged) {
    // In packaged app, use process.resourcesPath
    agentPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'agent', 'agent.py');
  } else {
    // In development, use the source agent directory
    agentPath = path.join(__dirname, '../../agent/agent.py');
  }

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

  agentProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        log(`AGENT EVENT: ${JSON.stringify(event)}`);
        mainWindow?.webContents.send('agent-event', event);
      } catch (e) {
        log(`PARSE ERROR: ${line} ${e}`);
      }
    }
  });

  agentProcess.stderr?.on('data', (data: Buffer) => {
    log(`AGENT STDERR: ${data.toString()}`);
    mainWindow?.webContents.send('agent-event', {
      type: 'log',
      data: { level: 'error', message: data.toString() },
    });
  });

  agentProcess.on('error', (err) => {
    log(`AGENT PROCESS ERROR: ${err}`);
    mainWindow?.webContents.send('agent-event', {
      type: 'log',
      data: { level: 'error', message: `进程错误: ${err}` },
    });
  });

  agentProcess.on('close', (code) => {
    log(`AGENT CLOSE: ${code}`);
    agentProcess = null;
  });

  // Send initial status after a short delay to ensure window is ready
  setTimeout(() => {
    log(`mainWindow exists: ${!!mainWindow}`);
    mainWindow?.webContents.send('agent-event', { type: 'status', data: { state: 'running' } });
  }, 1000);
}

function stopAgent() {
  if (!agentProcess) return;
  agentProcess.kill();
  agentProcess = null;
  mainWindow?.webContents.send('agent-event', { type: 'status', data: { state: 'stopped' } });
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
        languages: ["zh-Hans", "en"],
        trigger_keywords: config.ocr_trigger_keywords || "",
      },
      openclaw: {
        enabled: config.openclaw_enabled ?? false,
        cli_path: config.openclaw_cli_path || DEFAULT_OPENCLAW_CLI_PATH,
        timeout_seconds: config.openclaw_timeout_seconds || 120,
        extra_prompt: config.openclaw_extra_prompt || '',
        routes: Array.isArray(config.openclaw_routes) ? config.openclaw_routes : [],
      },

    };
    fs.writeFileSync(CONFIG_PATH, yaml.dump(nestedConfig), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save config:', e);
    return false;
  }
});

// 列出 OpenClaw Agents
ipcMain.handle('list-openclaw-agents', async () => {
  const parseJsonArray = (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i += 1) {
        const candidate = lines.slice(i).join('\n');
        if (!candidate.startsWith('[')) continue;
        try {
          const parsed = JSON.parse(candidate);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      throw new Error('OpenClaw agents output is not JSON');
    }
  };

  return new Promise((resolve) => {
    execFile(
      DEFAULT_OPENCLAW_CLI_PATH,
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
  setTimeout(() => startAgent(), 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => { stopAgent(); });
