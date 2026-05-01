import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';

export interface AgentEvent {
  type: string;
  data: any;
  ts?: string;
  id?: string;
}

export interface DashboardStats {
  keywordHits: number;
  visionRecognitions: number;
  aiReplies: number;
  escalations: number;
}

export interface DashboardStatsStore {
  day: DashboardStats;
  month: DashboardStats;
  year: DashboardStats;
  total: DashboardStats;
}

export interface PendingReply {
  id: string;
  channel: string;
  content: string;
  workflow_mode?: string;
  sender?: string;
  source?: string;
  ts?: string;
}

interface StoredToken {
  id: string;
  hash: string;
  deviceName: string;
  createdAt: string;
}

interface AuthState {
  tokens: StoredToken[];
}

export interface MobileControlServiceOptions {
  userDataPath: string;
  host?: string;
  port?: number;
  appVersion: string;
  getAgentRunning: () => boolean;
  getDashboardStats?: () => Promise<DashboardStatsStore | null> | DashboardStatsStore | null;
  startAgent: () => void;
  stopAgent: () => void;
  runAgentOnce: () => Promise<{ ok: boolean; reason?: string }>;
  confirmPendingReply: (id: string, content: string) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  cancelPendingReply: (id: string) => Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
  checkProcess: (name: string) => Promise<boolean>;
  loadConfig?: () => Promise<any> | any;
  saveConfig?: (config: any) => Promise<boolean> | boolean;
}

const DEFAULT_PORT = 47831;
const DEFAULT_HOST = '0.0.0.0';
const RETENTION_DAYS = 7;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const EMPTY_STATS: DashboardStats = {
  keywordHits: 0,
  visionRecognitions: 0,
  aiReplies: 0,
  escalations: 0,
};

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: any) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isSensitiveKey(key: string) {
  return /(api[_-]?key|webhook|webhook[_-]?url|token|secret|password|cli[_-]?path|screenshot[_-]?path|file[_-]?path|path)$/i.test(key);
}

function isLocalPath(value: string) {
  return /^\/(?:Users|private|var|tmp|Applications)\//.test(value) || /^[A-Za-z]:\\/.test(value);
}

export function sanitizeEvent(event: AgentEvent): AgentEvent {
  const sanitizeValue = (value: any, key = ''): any => {
    if (value === null || value === undefined) return value;
    if (isSensitiveKey(key)) {
      if (/path$/i.test(key) || /screenshot/i.test(key)) return '[local-path]';
      return '[redacted]';
    }
    if (typeof value === 'string') {
      return isLocalPath(value) ? '[local-path]' : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item));
    }
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeValue(childValue, childKey)]),
      );
    }
    return value;
  };

  return {
    id: event.id,
    ts: event.ts,
    type: String(event.type || 'log'),
    data: sanitizeValue(event.data || {}),
  };
}

function emptyStats(): DashboardStats {
  return { ...EMPTY_STATS };
}

function increment(stats: DashboardStats, key: keyof DashboardStats) {
  stats[key] += 1;
}

function mergeStats(primary: DashboardStats, fallback: DashboardStats): DashboardStats {
  return {
    keywordHits: primary.keywordHits || fallback.keywordHits,
    visionRecognitions: primary.visionRecognitions || fallback.visionRecognitions,
    aiReplies: primary.aiReplies || fallback.aiReplies,
    escalations: primary.escalations || fallback.escalations,
  };
}

function mergeStatsStore(primary: DashboardStatsStore, fallback?: DashboardStatsStore | null): DashboardStatsStore {
  if (!fallback) return primary;
  return {
    day: mergeStats(primary.day, fallback.day),
    month: mergeStats(primary.month, fallback.month),
    year: mergeStats(primary.year, fallback.year),
    total: mergeStats(primary.total, fallback.total),
  };
}

function sanitizeMobileConfig(config: any) {
  const ocr = config.ocr || {};
  return {
    wechat: { enabled: config.wechat?.enabled ?? true },
    wecom: { enabled: config.wecom?.enabled ?? true },
    workflow_mode: config.workflow_mode || 'customer',
    mode: config.mode || 'auto',
    escalation: {
      keywords: config.escalation?.keywords || '退款,投诉,经理,报警',
      max_unsolved_rounds: Number(config.escalation?.max_unsolved_rounds) || 2,
    },
    reply_delay_min: Number(config.reply_delay_min) || 1,
    reply_delay_max: Number(config.reply_delay_max) || 3,
    ocr: {
      enabled: ocr.enabled ?? true,
      fast_mode: ocr.fast_mode ?? true,
      check_interval: Number(ocr.check_interval) || 3,
      guard_enabled: ocr.guard_enabled ?? false,
      guard_previous_check_interval: Number(ocr.guard_previous_check_interval) || 3,
      trigger_keywords: ocr.trigger_keywords || '',
    },
  };
}

function mergeMobileConfig(current: any, patch: any) {
  const allowedWorkflowMode = patch.workflow_mode === 'assistant' ? 'assistant' : patch.workflow_mode === 'customer' ? 'customer' : current.workflow_mode;
  const allowedMode = patch.mode === 'assist' ? 'assist' : patch.mode === 'auto' ? 'auto' : current.mode;
  const next = {
    ...current,
    wechat: { ...(current.wechat || {}) },
    wecom: { ...(current.wecom || {}) },
    escalation: { ...(current.escalation || {}) },
    ocr: { ...(current.ocr || {}) },
  };

  if (patch.wechat && typeof patch.wechat.enabled === 'boolean') next.wechat.enabled = patch.wechat.enabled;
  if (patch.wecom && typeof patch.wecom.enabled === 'boolean') next.wecom.enabled = patch.wecom.enabled;
  if (allowedWorkflowMode) next.workflow_mode = allowedWorkflowMode;
  if (allowedMode) next.mode = allowedMode;
  if (patch.escalation) {
    if (typeof patch.escalation.keywords === 'string') next.escalation.keywords = patch.escalation.keywords;
    const maxRounds = Number(patch.escalation.max_unsolved_rounds);
    if (Number.isFinite(maxRounds)) next.escalation.max_unsolved_rounds = Math.min(Math.max(Math.round(maxRounds), 1), 10);
  }
  if (patch.ocr) {
    if (typeof patch.ocr.enabled === 'boolean') next.ocr.enabled = patch.ocr.enabled;
    if (typeof patch.ocr.fast_mode === 'boolean') next.ocr.fast_mode = patch.ocr.fast_mode;
    if (typeof patch.ocr.trigger_keywords === 'string') next.ocr.trigger_keywords = patch.ocr.trigger_keywords;
    if (typeof patch.ocr.guard_enabled === 'boolean') {
      const currentInterval = Number(next.ocr.check_interval) || 3;
      if (patch.ocr.guard_enabled && !next.ocr.guard_enabled) {
        next.ocr.guard_previous_check_interval = currentInterval;
        next.ocr.check_interval = 60;
      } else if (!patch.ocr.guard_enabled && next.ocr.guard_enabled) {
        next.ocr.check_interval = Number(next.ocr.guard_previous_check_interval) || 3;
      }
      next.ocr.guard_enabled = patch.ocr.guard_enabled;
    }
    const interval = Number(patch.ocr.check_interval);
    if (Number.isFinite(interval) && !next.ocr.guard_enabled) {
      next.ocr.check_interval = Math.min(Math.max(Math.round(interval), 1), 60);
    }
  }

  return next;
}

function isRouteMatchedEvent(event: AgentEvent) {
  if (event.type !== 'log') return false;
  const message = String(event.data?.message || '');
  if (/OpenClaw assistant route matched/i.test(message)) return false;
  return /助手模式命中路由|OpenClaw route matched|route matched/i.test(message);
}

function counterKeyForEvent(event: AgentEvent): keyof DashboardStats | null {
  if (isRouteMatchedEvent(event)) return 'keywordHits';
  if (event.type === 'ocr') return 'visionRecognitions';
  if (event.type === 'vision') return 'visionRecognitions';
  if (event.type === 'reply') return 'aiReplies';
  if (event.type === 'escalation') return 'escalations';
  return null;
}

function summarizeConnectionsFromEvents(events: AgentEvent[]) {
  let wechat: boolean | null = null;
  let wecom: boolean | null = null;
  for (const event of events.slice().reverse()) {
    const windowName = String(event.data?.window || '');
    const message = String(event.data?.message || '');
    const text = `${windowName} ${message}`;
    if (wecom === null && /企业微信/.test(text)) {
      if (/未检测到\s*\[?企业微信\]?|请确认已打开/.test(text)) wecom = false;
      if (/已检测到\s*\[?企业微信\]?|开始监控|画面变化|OCR|Vision/.test(text)) wecom = true;
    }
    if (wechat === null && /微信/.test(text) && !/企业微信/.test(text)) {
      if (/未检测到\s*\[?微信\]?|请确认已打开/.test(text)) wechat = false;
      if (/已检测到\s*\[?微信\]?|开始监控|画面变化|OCR|Vision/.test(text)) wechat = true;
    }
    if (wechat !== null && wecom !== null) break;
  }
  return { wechat, wecom };
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

function yearKey(date: Date) {
  return date.toISOString().slice(0, 4);
}

export function summarizeEvents(events: AgentEvent[], now = new Date()): DashboardStatsStore {
  const stats = {
    day: emptyStats(),
    month: emptyStats(),
    year: emptyStats(),
    total: emptyStats(),
  };
  const currentDay = dayKey(now);
  const currentMonth = monthKey(now);
  const currentYear = yearKey(now);

  for (const event of events) {
    const key = counterKeyForEvent(event);
    if (!key) continue;
    const eventDate = new Date(event.ts || Date.now());
    increment(stats.total, key);
    if (yearKey(eventDate) === currentYear) increment(stats.year, key);
    if (monthKey(eventDate) === currentMonth) increment(stats.month, key);
    if (dayKey(eventDate) === currentDay) increment(stats.day, key);
  }

  return stats;
}

export class EventStore {
  private events: AgentEvent[];

  constructor(private filePath: string, private retentionDays = RETENTION_DAYS) {
    this.events = readJsonFile<AgentEvent[]>(filePath, []);
  }

  addEvent(event: AgentEvent, now = new Date()) {
    const stored = sanitizeEvent({
      ...event,
      id: event.id || crypto.randomUUID(),
      ts: event.ts || now.toISOString(),
    });
    this.events.push(stored);
    this.prune(now);
    this.save();
    return stored;
  }

  listEvents(options: { since?: string; limit?: number; types?: string[]; now?: Date } = {}) {
    this.prune(options.now || new Date());
    let filtered = this.events;
    if (options.since) {
      const sinceMs = new Date(options.since).getTime();
      if (Number.isFinite(sinceMs)) {
        filtered = filtered.filter((event) => new Date(event.ts || 0).getTime() > sinceMs);
      }
    }
    if (options.types?.length) {
      const types = new Set(options.types);
      filtered = filtered.filter((event) => types.has(event.type));
    }
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
    return filtered.slice(-limit);
  }

  stats(now = new Date()) {
    this.prune(now);
    return summarizeEvents(this.events, now);
  }

  private prune(now: Date) {
    const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    this.events = this.events.filter((event) => new Date(event.ts || 0).getTime() >= cutoff);
  }

  private save() {
    writeJsonFile(this.filePath, this.events);
  }
}

export class PairingManager {
  private state: AuthState;
  private activePairing: { code: string; expiresAt: number } | null = null;

  constructor(private filePath: string, private now: () => Date = () => new Date()) {
    this.state = readJsonFile<AuthState>(filePath, { tokens: [] });
  }

  private pairAttempts = new Map<string, { count: number; lockedUntil: number }>();

  startPairing() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      code += chars[bytes[i] % chars.length];
    }
    const expiresAt = this.now().getTime() + PAIRING_TTL_MS;
    this.activePairing = { code, expiresAt };
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  completePairing(code: string, deviceName = 'Mobile', remoteIp = '') {
    if (remoteIp) {
      const attempt = this.pairAttempts.get(remoteIp);
      if (attempt && attempt.lockedUntil > this.now().getTime()) {
        return { error: 'too many attempts, try again later' } as any;
      }
    }

    if (!this.activePairing) return null;
    if (this.activePairing.expiresAt < this.now().getTime()) {
      this.activePairing = null;
      return null;
    }
    if (String(code).trim().toUpperCase() !== this.activePairing.code) {
      if (remoteIp) {
        const attempt = this.pairAttempts.get(remoteIp) || { count: 0, lockedUntil: 0 };
        attempt.count += 1;
        if (attempt.count >= 5) {
          attempt.lockedUntil = this.now().getTime() + 10 * 60 * 1000;
        }
        this.pairAttempts.set(remoteIp, attempt);
      }
      return null;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const record: StoredToken = {
      id: crypto.randomUUID(),
      hash: hashToken(token),
      deviceName: String(deviceName || 'Mobile').slice(0, 80),
      createdAt: this.now().toISOString(),
    };
    this.state.tokens.push(record);
    this.activePairing = null;
    if (remoteIp) this.pairAttempts.delete(remoteIp);
    this.save();
    return { token, deviceId: record.id, deviceName: record.deviceName };
  }

  isTokenValid(token: string | null | undefined) {
    if (!token) return false;
    const hash = hashToken(token);
    return this.state.tokens.some((record) => record.hash === hash);
  }

  hasPairedDevices() {
    return this.state.tokens.length > 0;
  }

  private save() {
    writeJsonFile(this.filePath, this.state);
  }
}

function parseBearer(req: http.IncomingMessage) {
  const auth = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] : auth);
  return match?.[1] || null;
}

function isLoopback(req: http.IncomingMessage) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  });
  res.end(JSON.stringify(data));
}

function sendWebSocketText(socket: any, payload: string) {
  const data = Buffer.from(payload);
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
}

export class MobileControlService {
  private server: http.Server;
  private clients = new Set<any>();
  private eventStore: EventStore;
  private pairing: PairingManager;
  private pendingReplies = new Map<string, PendingReply>();

  public port: number;

  constructor(private options: MobileControlServiceOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.eventStore = new EventStore(path.join(options.userDataPath, 'mobile-events.json'), RETENTION_DAYS);
    this.pairing = new PairingManager(path.join(options.userDataPath, 'mobile-auth.json'));
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        sendJson(res, 500, { ok: false, error: String(error) });
      });
    });
    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
  }

  start() {
    if (this.server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.options.host ?? DEFAULT_HOST, () => {
        const address = this.server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  stop() {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {}
    }
    this.clients.clear();
    return new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  startPairing() {
    return this.pairing.startPairing();
  }

  ingestAgentEvent(event: AgentEvent) {
    const stored = this.eventStore.addEvent(event);
    if (stored.type === 'pending_reply' && stored.data?.id) {
      this.pendingReplies.set(String(stored.data.id), {
        id: String(stored.data.id),
        channel: String(stored.data.channel || ''),
        content: String(stored.data.content || ''),
        workflow_mode: stored.data.workflow_mode,
        sender: stored.data.sender,
        source: stored.data.source,
        ts: stored.ts,
      });
    }
    const payload = JSON.stringify({ type: 'event', event: stored });
    for (const client of this.clients) {
      try {
        sendWebSocketText(client, payload);
      } catch {
        this.clients.delete(client);
      }
    }
    return stored;
  }

  broadcastConfig(config: any) {
    const payload = JSON.stringify({ type: 'config', config: sanitizeMobileConfig(config || {}) });
    for (const client of this.clients) {
      try {
        sendWebSocketText(client, payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  clearPendingReply(id: string) {
    this.pendingReplies.delete(id);
  }

  listPendingReplies() {
    return Array.from(this.pendingReplies.values());
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        version: this.options.appVersion,
        running: this.options.getAgentRunning(),
        paired: this.pairing.hasPairedDevices(),
        authRequired: true,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pair/start') {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'pairing must be started from desktop' });
        return;
      }
      sendJson(res, 200, { ok: true, ...this.startPairing() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pair/complete') {
      const remoteIp = req.socket.remoteAddress || '';
      const body = await readBody(req);
      const result = this.pairing.completePairing(body.code, body.deviceName, remoteIp);
      if (!result) {
        sendJson(res, 401, { ok: false, error: 'invalid pairing code' });
        return;
      }
      if (result.error) {
        sendJson(res, 429, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (!this.pairing.isTokenValid(parseBearer(req))) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const types = (url.searchParams.get('types') || '').split(',').map((item) => item.trim()).filter(Boolean);
      const limit = Number(url.searchParams.get('limit') || 100);
      sendJson(res, 200, {
        ok: true,
        events: this.eventStore.listEvents({
          since: url.searchParams.get('since') || undefined,
          limit,
          types,
        }),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const [wechat, wecom] = await Promise.all([
        this.options.checkProcess('WeChat'),
        this.options.checkProcess('企业微信'),
      ]);
      const config = await this.options.loadConfig?.();
      const events = this.eventStore.listEvents({ limit: 500 });
      const desktopStats = await this.options.getDashboardStats?.();
      const eventConnections = summarizeConnectionsFromEvents(events);
      sendJson(res, 200, {
        ok: true,
        running: this.options.getAgentRunning(),
        connections: {
          wechat: eventConnections.wechat ?? wechat,
          wecom: eventConnections.wecom ?? wecom,
        },
        stats: mergeStatsStore(this.eventStore.stats(), desktopStats),
        config: sanitizeMobileConfig(config || {}),
        pendingReplies: this.listPendingReplies(),
        latestEvents: events.filter((event) => (
          event.type === 'vision' ||
          event.type === 'reply' ||
          event.type === 'escalation' ||
          isRouteMatchedEvent(event)
        )).slice(-6),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const config = await this.options.loadConfig?.();
      sendJson(res, 200, {
        ok: true,
        config: sanitizeMobileConfig(config || {}),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      if (!this.options.loadConfig || !this.options.saveConfig) {
        sendJson(res, 501, { ok: false, error: 'config API unavailable' });
        return;
      }
      const body = await readBody(req);
      const current = await this.options.loadConfig();
      const next = mergeMobileConfig(current || {}, body.config || {});
      const ok = await this.options.saveConfig(next);
      sendJson(res, ok ? 200 : 500, { ok, config: sanitizeMobileConfig(next) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pending-replies') {
      sendJson(res, 200, {
        ok: true,
        pendingReplies: this.listPendingReplies(),
      });
      return;
    }

    const pendingConfirmMatch = /^\/api\/pending-replies\/([^/]+)\/confirm$/.exec(url.pathname);
    if (req.method === 'POST' && pendingConfirmMatch) {
      const id = decodeURIComponent(pendingConfirmMatch[1]);
      const body = await readBody(req);
      const content = String(body.content || '').trim();
      if (!content) {
        sendJson(res, 400, { ok: false, error: 'content is required' });
        return;
      }
      const result = await this.options.confirmPendingReply(id, content);
      if (result.ok) this.clearPendingReply(id);
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, reason: result.reason });
      return;
    }

    const pendingCancelMatch = /^\/api\/pending-replies\/([^/]+)\/cancel$/.exec(url.pathname);
    if (req.method === 'POST' && pendingCancelMatch) {
      const id = decodeURIComponent(pendingCancelMatch[1]);
      const result = await this.options.cancelPendingReply(id);
      if (result.ok) this.clearPendingReply(id);
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, reason: result.reason });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent/start') {
      this.options.startAgent();
      sendJson(res, 200, { ok: true, running: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent/stop') {
      this.options.stopAgent();
      sendJson(res, 200, { ok: true, running: false });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/agent/run-once') {
      const result = await this.options.runAgentOnce();
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, reason: result.reason });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: any) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/events/stream' || !this.pairing.isTokenValid(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    sendWebSocketText(socket, JSON.stringify({ type: 'hello', running: this.options.getAgentRunning() }));
  }
}
