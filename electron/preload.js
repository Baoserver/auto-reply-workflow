"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    onAgentEvent: function (callback) {
        electron_1.ipcRenderer.on('agent-event', function (_e, data) { return callback(data); });
    },
    removeAgentEventListener: function () {
        electron_1.ipcRenderer.removeAllListeners('agent-event');
    },
    startAgent: function () { return electron_1.ipcRenderer.send('agent-start'); },
    stopAgent: function () { return electron_1.ipcRenderer.send('agent-stop'); },
    sendCommand: function (cmd) { return electron_1.ipcRenderer.send('agent-command', cmd); },
    loadConfig: function () { return electron_1.ipcRenderer.invoke('load-config'); },
    saveConfig: function (config) { return electron_1.ipcRenderer.invoke('save-config', config); },
    listKnowledgeFiles: function () { return electron_1.ipcRenderer.invoke('list-knowledge-files'); },
    writeKnowledgeFile: function (filename, content) {
        return electron_1.ipcRenderer.invoke('write-knowledge-file', filename, content);
    },
    deleteKnowledgeFile: function (filename) {
        return electron_1.ipcRenderer.invoke('delete-knowledge-file', filename);
    },
    checkProcess: function (name) { return electron_1.ipcRenderer.invoke('check-process', name); },
});
