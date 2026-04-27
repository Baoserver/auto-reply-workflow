"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const child_process_2 = require("child_process");
let mainWindow = null;
let tray = null;
let agentProcess = null;
let LOG_FILE;
function log(msg) {
    if (!LOG_FILE) {
        try {
            LOG_FILE = path.join(electron_1.app.getPath('userData'), 'app.log');
        }
        catch (e) {
            console.error('Failed to get userData path:', e);
            return;
        }
    }
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_FILE, logLine);
    }
    catch (e) {
        console.error('Failed to write log:', e);
    }
    console.log(logLine.trim());
}
// Determine paths based on whether app is packaged
function getConfigPath() {
    if (electron_1.app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'config.yaml');
    }
    return path.join(__dirname, '../../config.yaml');
}
function getKnowledgeDir() {
    if (electron_1.app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'agent', 'knowledge');
    }
    return path.join(__dirname, '../../agent/knowledge');
}
const CONFIG_PATH = getConfigPath();
const KNOWLEDGE_DIR = getKnowledgeDir();
function createTrayIcon() {
    const size = 16;
    const img = electron_1.nativeImage.createEmpty();
    return img;
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 430,
        height: 780,
        minWidth: 375,
        minHeight: 667,
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
    tray = new electron_1.Tray(icon);
    const contextMenu = electron_1.Menu.buildFromTemplate([
        { label: '显示窗口', click: () => { if (!mainWindow)
                createWindow(); mainWindow?.show(); } },
        { type: 'separator' },
        { label: '开始监控', click: () => startAgent() },
        { label: '停止监控', click: () => stopAgent() },
        { type: 'separator' },
        { label: '退出', click: () => { electron_1.app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip('视觉智能客服');
    tray.on('click', () => {
        if (!mainWindow)
            createWindow();
        mainWindow?.show();
    });
}
// --- Python Agent 管理 ---
function startAgent() {
    if (agentProcess)
        return;
    console.log('[startAgent] called, isPackaged:', electron_1.app.isPackaged);
    console.log('[startAgent] resourcesPath:', process.resourcesPath);
    // Determine the correct path based on whether app is packaged
    let agentPath;
    if (electron_1.app.isPackaged) {
        // In packaged app, use process.resourcesPath
        agentPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'agent', 'agent.py');
    }
    else {
        // In development, use the source agent directory
        agentPath = path.join(__dirname, '../../agent/agent.py');
    }
    log(`agentPath: ${agentPath}`);
    log(`isPackaged: ${electron_1.app.isPackaged}`);
    log(`resourcesPath: ${process.resourcesPath}`);
    try {
        agentProcess = (0, child_process_1.spawn)('python3', [agentPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        log(`spawn succeeded, pid: ${agentProcess.pid}`);
    }
    catch (err) {
        log(`spawn error: ${err}`);
        mainWindow?.webContents.send('agent-event', {
            type: 'log',
            data: { level: 'error', message: `启动失败: ${err}` },
        });
        return;
    }
    agentProcess.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const event = JSON.parse(line);
                log(`AGENT EVENT: ${JSON.stringify(event)}`);
                mainWindow?.webContents.send('agent-event', event);
            }
            catch (e) {
                log(`PARSE ERROR: ${line} ${e}`);
            }
        }
    });
    agentProcess.stderr?.on('data', (data) => {
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
    if (!agentProcess)
        return;
    agentProcess.kill();
    agentProcess = null;
    mainWindow?.webContents.send('agent-event', { type: 'status', data: { state: 'stopped' } });
}
// --- IPC 处理 ---
electron_1.ipcMain.on('agent-start', () => {
    console.log('[IPC] agent-start received');
    startAgent();
});
electron_1.ipcMain.on('agent-stop', () => stopAgent());
electron_1.ipcMain.on('agent-command', (_e, cmd) => {
    agentProcess?.stdin?.write(JSON.stringify({ action: cmd }) + '\n');
});
// 读取配置
electron_1.ipcMain.handle('load-config', async () => {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const yaml = require('js-yaml');
            const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
            return yaml.load(content) || {};
        }
    }
    catch (e) {
        console.error('Failed to load config:', e);
    }
    return {};
});
// 保存配置
electron_1.ipcMain.handle('save-config', async (_e, config) => {
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
        };
        fs.writeFileSync(CONFIG_PATH, yaml.dump(nestedConfig), 'utf-8');
        return true;
    }
    catch (e) {
        console.error('Failed to save config:', e);
        return false;
    }
});
// 列出知识库文件
electron_1.ipcMain.handle('list-knowledge-files', async () => {
    try {
        if (!fs.existsSync(KNOWLEDGE_DIR)) {
            fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
        }
        const files = fs.readdirSync(KNOWLEDGE_DIR);
        return files.map((f) => {
            const stats = fs.statSync(path.join(KNOWLEDGE_DIR, f));
            return { name: f, size: `${(stats.size / 1024).toFixed(1)} KB`, updatedAt: '刚刚' };
        });
    }
    catch (e) {
        console.error('Failed to list knowledge files:', e);
        return [];
    }
});
// 写入知识库文件
electron_1.ipcMain.handle('write-knowledge-file', async (_e, filename, content) => {
    try {
        if (!fs.existsSync(KNOWLEDGE_DIR)) {
            fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
        }
        fs.writeFileSync(path.join(KNOWLEDGE_DIR, filename), content, 'utf-8');
        return true;
    }
    catch (e) {
        console.error('Failed to write knowledge file:', e);
        return false;
    }
});
// 删除知识库文件
electron_1.ipcMain.handle('delete-knowledge-file', async (_e, filename) => {
    try {
        const filePath = path.join(KNOWLEDGE_DIR, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }
    catch (e) {
        console.error('Failed to delete knowledge file:', e);
        return false;
    }
});
// 检查进程是否存在
electron_1.ipcMain.handle('check-process', async (_e, name) => {
    try {
        const result = (0, child_process_2.execSync)(`pgrep -xi "${name}"`, { encoding: 'utf-8' });
        return result.trim().length > 0;
    }
    catch {
        return false;
    }
});
// --- App 生命周期 ---
electron_1.app.whenReady().then(() => {
    createWindow();
    createTray();
    // Auto-start agent for testing
    setTimeout(() => startAgent(), 2000);
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('activate', () => {
    if (!mainWindow)
        createWindow();
});
electron_1.app.on('before-quit', () => { stopAgent(); });
