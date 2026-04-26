"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
var path = require("path");
var fs = require("fs");
var child_process_1 = require("child_process");
var child_process_2 = require("child_process");
var mainWindow = null;
var tray = null;
var agentProcess = null;
var CONFIG_PATH = path.join(__dirname, '../../config.yaml');
var KNOWLEDGE_DIR = path.join(__dirname, '../../agent/knowledge');
function createTrayIcon() {
    var size = 16;
    var img = electron_1.nativeImage.createEmpty();
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
    mainWindow.once('ready-to-show', function () { return mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.show(); });
    mainWindow.on('closed', function () {
        stopAgent();
        mainWindow = null;
    });
}
function createTray() {
    var icon = createTrayIcon();
    tray = new electron_1.Tray(icon);
    var contextMenu = electron_1.Menu.buildFromTemplate([
        { label: '显示窗口', click: function () { if (!mainWindow)
                createWindow(); mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.show(); } },
        { type: 'separator' },
        { label: '开始监控', click: function () { return startAgent(); } },
        { label: '停止监控', click: function () { return stopAgent(); } },
        { type: 'separator' },
        { label: '退出', click: function () { electron_1.app.quit(); } },
    ]);
    tray.setContextMenu(contextMenu);
    tray.setToolTip('视觉智能客服');
    tray.on('click', function () {
        if (!mainWindow)
            createWindow();
        mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.show();
    });
}
// --- Python Agent 管理 ---
function startAgent() {
    var _a, _b;
    if (agentProcess)
        return;
    var agentPath = path.join(__dirname, '../../agent/agent.py');
    agentProcess = (0, child_process_1.spawn)('python3', [agentPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    (_a = agentProcess.stdout) === null || _a === void 0 ? void 0 : _a.on('data', function (data) {
        var lines = data.toString().split('\n').filter(Boolean);
        for (var _i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
            var line = lines_1[_i];
            try {
                var event_1 = JSON.parse(line);
                console.log('[AGENT EVENT]', JSON.stringify(event_1));
                mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.webContents.send('agent-event', event_1);
            }
            catch (e) {
                console.log('[PARSE ERROR]', line, e);
            }
        }
    });
    (_b = agentProcess.stderr) === null || _b === void 0 ? void 0 : _b.on('data', function (data) {
        mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.webContents.send('agent-event', {
            type: 'log',
            data: { level: 'error', message: data.toString() },
        });
    });
    agentProcess.on('close', function () { agentProcess = null; });
    // Send initial status after a short delay to ensure window is ready
    setTimeout(function () {
        console.log('[START AGENT] mainWindow exists:', !!mainWindow);
        mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.webContents.send('agent-event', { type: 'status', data: { state: 'running' } });
    }, 1000);
}
function stopAgent() {
    if (!agentProcess)
        return;
    agentProcess.kill();
    agentProcess = null;
    mainWindow === null || mainWindow === void 0 ? void 0 : mainWindow.webContents.send('agent-event', { type: 'status', data: { state: 'stopped' } });
}
// --- IPC 处理 ---
electron_1.ipcMain.on('agent-start', function () { return startAgent(); });
electron_1.ipcMain.on('agent-stop', function () { return stopAgent(); });
electron_1.ipcMain.on('agent-command', function (_e, cmd) {
    var _a;
    (_a = agentProcess === null || agentProcess === void 0 ? void 0 : agentProcess.stdin) === null || _a === void 0 ? void 0 : _a.write(JSON.stringify({ action: cmd }) + '\n');
});
// 读取配置
electron_1.ipcMain.handle('load-config', function () { return __awaiter(void 0, void 0, void 0, function () {
    var yaml, content;
    return __generator(this, function (_a) {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                yaml = require('js-yaml');
                content = fs.readFileSync(CONFIG_PATH, 'utf-8');
                return [2 /*return*/, yaml.load(content) || {}];
            }
        }
        catch (e) {
            console.error('Failed to load config:', e);
        }
        return [2 /*return*/, {}];
    });
}); });
// 保存配置
electron_1.ipcMain.handle('save-config', function (_e, config) { return __awaiter(void 0, void 0, void 0, function () {
    var yaml, nestedConfig;
    var _a, _b;
    return __generator(this, function (_c) {
        try {
            yaml = require('js-yaml');
            nestedConfig = {
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
                    enabled: (_a = config.wechat_enabled) !== null && _a !== void 0 ? _a : true,
                    window_title: '微信',
                },
                wecom: {
                    enabled: (_b = config.wecom_enabled) !== null && _b !== void 0 ? _b : true,
                    window_title: '企业微信',
                },
                mode: config.mode || 'auto',
                escalation: {
                    keywords: config.escalation_keywords || '退款,投诉,经理,报警',
                    max_unsolved_rounds: config.max_unsolved_rounds || 2,
                },
                reply_delay_min: config.reply_delay_min || 1,
                reply_delay_max: config.reply_delay_max || 3,
            };
            fs.writeFileSync(CONFIG_PATH, yaml.dump(nestedConfig), 'utf-8');
            return [2 /*return*/, true];
        }
        catch (e) {
            console.error('Failed to save config:', e);
            return [2 /*return*/, false];
        }
        return [2 /*return*/];
    });
}); });
// 列出知识库文件
electron_1.ipcMain.handle('list-knowledge-files', function () { return __awaiter(void 0, void 0, void 0, function () {
    var files;
    return __generator(this, function (_a) {
        try {
            if (!fs.existsSync(KNOWLEDGE_DIR)) {
                fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
            }
            files = fs.readdirSync(KNOWLEDGE_DIR);
            return [2 /*return*/, files.map(function (f) {
                    var stats = fs.statSync(path.join(KNOWLEDGE_DIR, f));
                    return { name: f, size: "".concat((stats.size / 1024).toFixed(1), " KB"), updatedAt: '刚刚' };
                })];
        }
        catch (e) {
            console.error('Failed to list knowledge files:', e);
            return [2 /*return*/, []];
        }
        return [2 /*return*/];
    });
}); });
// 写入知识库文件
electron_1.ipcMain.handle('write-knowledge-file', function (_e, filename, content) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        try {
            if (!fs.existsSync(KNOWLEDGE_DIR)) {
                fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
            }
            fs.writeFileSync(path.join(KNOWLEDGE_DIR, filename), content, 'utf-8');
            return [2 /*return*/, true];
        }
        catch (e) {
            console.error('Failed to write knowledge file:', e);
            return [2 /*return*/, false];
        }
        return [2 /*return*/];
    });
}); });
// 删除知识库文件
electron_1.ipcMain.handle('delete-knowledge-file', function (_e, filename) { return __awaiter(void 0, void 0, void 0, function () {
    var filePath;
    return __generator(this, function (_a) {
        try {
            filePath = path.join(KNOWLEDGE_DIR, filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return [2 /*return*/, true];
            }
            return [2 /*return*/, false];
        }
        catch (e) {
            console.error('Failed to delete knowledge file:', e);
            return [2 /*return*/, false];
        }
        return [2 /*return*/];
    });
}); });
// 检查进程是否存在
electron_1.ipcMain.handle('check-process', function (_e, name) { return __awaiter(void 0, void 0, void 0, function () {
    var result;
    return __generator(this, function (_a) {
        try {
            result = (0, child_process_2.execSync)("pgrep -xi \"".concat(name, "\""), { encoding: 'utf-8' });
            return [2 /*return*/, result.trim().length > 0];
        }
        catch (_b) {
            return [2 /*return*/, false];
        }
        return [2 /*return*/];
    });
}); });
// --- App 生命周期 ---
electron_1.app.whenReady().then(function () {
    createWindow();
    createTray();
});
electron_1.app.on('window-all-closed', function () {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('activate', function () {
    if (!mainWindow)
        createWindow();
});
electron_1.app.on('before-quit', function () { stopAgent(); });
