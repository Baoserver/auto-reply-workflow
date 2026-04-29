import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import Dashboard from './components/Dashboard';
import ConfigPanel from './components/ConfigPanel';
import ChatMonitor from './components/ChatMonitor';
import KnowledgeManager from './components/KnowledgeManager';
import WorkflowPanel from './components/WorkflowPanel';

interface AgentEvent {
  type: string;
  data: any;
}

interface Connection {
  wechat: boolean;
  wecom: boolean;
}

interface DashboardStats {
  keywordHits: number;
  visionRecognitions: number;
  aiReplies: number;
  escalations: number;
}

interface DashboardStatsStore {
  dayKey: string;
  monthKey: string;
  yearKey: string;
  day: DashboardStats;
  month: DashboardStats;
  year: DashboardStats;
  total: DashboardStats;
}

const DEFAULT_MAIN_WIDTH = 430;
const DEFAULT_LOG_WIDTH = 390;
const MIN_MAIN_WIDTH = 375;
const MAX_MAIN_WIDTH = 760;
const MIN_LOG_WIDTH = 320;
const MAX_LOG_WIDTH = 720;
const STATS_STORAGE_KEY = 'vision-cs-dashboard-stats';
const EMPTY_DASHBOARD_STATS: DashboardStats = {
  keywordHits: 0,
  visionRecognitions: 0,
  aiReplies: 0,
  escalations: 0,
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const todayKey = () => new Date().toISOString().slice(0, 10);
const monthKey = () => todayKey().slice(0, 7);
const yearKey = () => todayKey().slice(0, 4);

const emptyStats = (): DashboardStats => ({ ...EMPTY_DASHBOARD_STATS });

const normalizeStats = (value: any): DashboardStats => ({
  keywordHits: Number(value?.keywordHits) || 0,
  visionRecognitions: Number(value?.visionRecognitions) || 0,
  aiReplies: Number(value?.aiReplies) || 0,
  escalations: Number(value?.escalations) || 0,
});

const normalizeStatsStore = (store: DashboardStatsStore): DashboardStatsStore => {
  const currentDay = todayKey();
  const currentMonth = monthKey();
  const currentYear = yearKey();
  return {
    ...store,
    dayKey: currentDay,
    monthKey: currentMonth,
    yearKey: currentYear,
    day: store.dayKey === currentDay ? store.day : emptyStats(),
    month: store.monthKey === currentMonth ? store.month : emptyStats(),
    year: store.yearKey === currentYear ? store.year : emptyStats(),
  };
};

const loadDashboardStats = (): DashboardStatsStore => {
  try {
    const stored = localStorage.getItem(STATS_STORAGE_KEY);
    if (!stored) {
      return normalizeStatsStore({
        dayKey: todayKey(),
        monthKey: monthKey(),
        yearKey: yearKey(),
        day: emptyStats(),
        month: emptyStats(),
        year: emptyStats(),
        total: emptyStats(),
      });
    }
    const parsed = JSON.parse(stored);
    if (parsed?.day || parsed?.month || parsed?.year || parsed?.total) {
      return normalizeStatsStore({
        dayKey: parsed.dayKey || parsed.date || todayKey(),
        monthKey: parsed.monthKey || monthKey(),
        yearKey: parsed.yearKey || yearKey(),
        day: normalizeStats(parsed.day),
        month: normalizeStats(parsed.month),
        year: normalizeStats(parsed.year),
        total: normalizeStats(parsed.total),
      });
    }
    const migrated = normalizeStats(parsed);
    return normalizeStatsStore({
      dayKey: parsed?.date || todayKey(),
      monthKey: monthKey(),
      yearKey: yearKey(),
      day: migrated,
      month: migrated,
      year: migrated,
      total: migrated,
    });
  } catch {
    return normalizeStatsStore({
      dayKey: todayKey(),
      monthKey: monthKey(),
      yearKey: yearKey(),
      day: emptyStats(),
      month: emptyStats(),
      year: emptyStats(),
      total: emptyStats(),
    });
  }
};

const isRouteMatchedEvent = (event: AgentEvent) => {
  if (event.type !== 'log') return false;
  const message = String(event.data?.message || '');
  if (/OpenClaw assistant route matched/i.test(message)) return false;
  return /助手模式命中路由|OpenClaw route matched|route matched/i.test(message);
};

const incrementStats = (stats: DashboardStats, key: keyof DashboardStats): DashboardStats => ({
  ...stats,
  [key]: stats[key] + 1,
});

const incrementStatsForEvent = (store: DashboardStatsStore, event: AgentEvent): DashboardStatsStore => {
  const normalized = normalizeStatsStore(store);
  let key: keyof DashboardStats | null = null;
  if (isRouteMatchedEvent(event)) {
    key = 'keywordHits';
  } else if (event.type === 'vision') {
    key = 'visionRecognitions';
  } else if (event.type === 'reply') {
    key = 'aiReplies';
  } else if (event.type === 'escalation') {
    key = 'escalations';
  }
  if (!key) return normalized;
  return {
    ...normalized,
    day: incrementStats(normalized.day, key),
    month: incrementStats(normalized.month, key),
    year: incrementStats(normalized.year, key),
    total: incrementStats(normalized.total, key),
  };
};

const TabIcon = ({ name, active }: { name: string; active: boolean }) => {
  const color = active ? '#171717' : '#7B715F';
  switch (name) {
    case 'home':
      return (
        <svg viewBox="0 0 24 24" fill={active ? '#F7D748' : 'none'} stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      );
    case 'log':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
      );
    case 'me':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
      );
    case 'workflow':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="6" height="6" rx="1.5"/>
          <rect x="15" y="4" width="6" height="6" rx="1.5"/>
          <rect x="9" y="15" width="6" height="6" rx="1.5"/>
          <path d="M9 7h6"/>
          <path d="M18 10v2a3 3 0 0 1-3 3h-3"/>
          <path d="M6 10v2a3 3 0 0 0 3 3h3"/>
        </svg>
      );
    default:
        return null;
  }
};

export default function App() {
  const [tab, setTab] = useState<string>('home');
  const [running, setRunning] = useState(false);
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [logDrawerFocused, setLogDrawerFocused] = useState(false);
  const [recognizingOnce, setRecognizingOnce] = useState(false);
  const [mainWidth, setMainWidth] = useState(DEFAULT_MAIN_WIDTH);
  const [logWidth, setLogWidth] = useState(DEFAULT_LOG_WIDTH);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stats, setStats] = useState<DashboardStatsStore>(() => loadDashboardStats());
  const [connections, setConnections] = useState<Connection>({ wechat: false, wecom: false });
  const paneSyncRef = useRef(false);
  const paneSyncTimerRef = useRef<number | null>(null);
  const resizeRef = useRef<null | {
    pane: 'main' | 'log';
    startX: number;
    startMainWidth: number;
    startLogWidth: number;
  }>(null);

  const handleStartStop = useCallback(() => {
    if (running) {
      window.electronAPI?.stopAgent();
    } else {
      window.electronAPI?.startAgent();
    }
  }, [running]);

  const handleRunOnce = useCallback(async () => {
    if (running || recognizingOnce || !window.electronAPI?.runAgentOnce) return;
    setRecognizingOnce(true);
    try {
      const result = await window.electronAPI.runAgentOnce();
      if (!result?.ok && result?.reason) {
        setEvents((prev) => [...prev.slice(-100), {
          type: 'log',
          data: { level: 'warn', message: `单次识别未执行: ${result.reason}` },
        }]);
      }
    } catch (e) {
      setEvents((prev) => [...prev.slice(-100), {
        type: 'log',
        data: { level: 'error', message: `单次识别异常: ${e}` },
      }]);
    } finally {
      setRecognizingOnce(false);
    }
  }, [running, recognizingOnce]);

  const openLogDrawer = useCallback(() => {
    setLogDrawerOpen(true);
    setLogDrawerFocused(true);
  }, []);

  const handleAppPointerDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!logDrawerOpen) return;
    const target = event.target as HTMLElement;
    setLogDrawerFocused(Boolean(target.closest('.log-drawer')));
  }, [logDrawerOpen]);

  const startPaneResize = useCallback((pane: 'main' | 'log', event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pane,
      startX: event.clientX,
      startMainWidth: mainWidth,
      startLogWidth: logWidth,
    };
    document.body.classList.add('pane-resizing');
  }, [mainWidth, logWidth]);

  useEffect(() => {
    if (!window.electronAPI) return;

    const handleEvent = (event: AgentEvent) => {
      console.log('[FRONTEND EVENT]', event.type, event.data);
      setEvents((prev) => [...prev.slice(-100), event]);
      setStats((prev) => incrementStatsForEvent(prev, event));

      if (event.type === 'status') {
        setRunning(event.data.state === 'running');
      }
    };

    window.electronAPI.onAgentEvent(handleEvent);

    return () => {
      window.electronAPI?.removeAgentEventListener();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
  }, [stats]);

  useEffect(() => {
    const checkConnections = async () => {
      if (!window.electronAPI) return;
      try {
        const wechat = await window.electronAPI.checkProcess('WeChat');
        const wecom = await window.electronAPI.checkProcess('企业微信');
        setConnections({ wechat, wecom });
      } catch (e) {
        console.error('Failed to check processes:', e);
      }
    };

    checkConnections();
    const interval = setInterval(checkConnections, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      const current = resizeRef.current;
      if (!current) return;
      const delta = event.clientX - current.startX;
      if (current.pane === 'main') {
        setMainWidth(clamp(current.startMainWidth + delta, MIN_MAIN_WIDTH, MAX_MAIN_WIDTH));
      } else {
        const totalWidth = current.startMainWidth + current.startLogWidth;
        const minLogWidth = Math.max(MIN_LOG_WIDTH, totalWidth - MAX_MAIN_WIDTH);
        const maxLogWidth = Math.min(MAX_LOG_WIDTH, totalWidth - MIN_MAIN_WIDTH);
        const nextLogWidth = clamp(current.startLogWidth - delta, minLogWidth, maxLogWidth);
        setLogWidth(nextLogWidth);
        setMainWidth(totalWidth - nextLogWidth);
      }
    };
    const handleUp = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.classList.remove('pane-resizing');
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.classList.remove('pane-resizing');
    };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onPaneLayoutChanged) return;
    return window.electronAPI.onPaneLayoutChanged((layout) => {
      paneSyncRef.current = true;
      if (paneSyncTimerRef.current !== null) {
        window.clearTimeout(paneSyncTimerRef.current);
      }
      if (typeof layout.mainWidth === 'number') {
        setMainWidth(clamp(layout.mainWidth, MIN_MAIN_WIDTH, MAX_MAIN_WIDTH));
      }
      if (typeof layout.drawerWidth === 'number') {
        setLogWidth(clamp(layout.drawerWidth, MIN_LOG_WIDTH, MAX_LOG_WIDTH));
      }
      if (typeof layout.drawerOpen === 'boolean') {
        setLogDrawerOpen(layout.drawerOpen);
      }
      paneSyncTimerRef.current = window.setTimeout(() => {
        paneSyncRef.current = false;
        paneSyncTimerRef.current = null;
      }, 350);
    });
  }, []);

  useEffect(() => {
    if (paneSyncRef.current) return;
    window.electronAPI?.setPaneLayout?.({
      mainWidth,
      drawerWidth: logWidth,
      drawerOpen: logDrawerOpen,
    });
    if (logDrawerOpen) {
      setLogDrawerFocused(true);
    }
  }, [mainWidth, logWidth, logDrawerOpen]);

  useEffect(() => () => {
    window.electronAPI?.setLogDrawerOpen?.(false);
  }, []);

  const tabs = [
    { key: 'home', label: '首页', icon: 'home' },
    { key: 'workflow', label: '工作流', icon: 'workflow' },
    { key: 'me', label: '知识库', icon: 'me' },
    { key: 'log', label: '日志', icon: 'log' },
  ];

  const renderContent = () => {
    switch (tab) {
      case 'home':
        return <Dashboard running={running} stats={stats} connections={connections} events={events} />;
      case 'workflow':
        return <WorkflowPanel />;
      case 'me':
        return <KnowledgeManager />;
      case 'settings':
        return <ConfigPanel />;
      default:
        return null;
    }
  };

  return (
    <div
      className={`app ${logDrawerOpen ? 'log-drawer-open' : ''} ${logDrawerOpen && logDrawerFocused ? 'log-drawer-focused' : 'log-drawer-main-focused'}`}
      style={{
        '--app-width': `${mainWidth}px`,
        '--log-drawer-width': `${logWidth}px`,
      } as React.CSSProperties}
      onMouseDownCapture={handleAppPointerDown}
    >
      <header className="app-header">
        {tab === 'settings' ? (
          <button className="header-back" onClick={() => setTab('home')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            <span>返回</span>
          </button>
        ) : (
          <span className="header-title">
            <img className="header-logo" src="assets/app-logo.png" alt="" />
            智回复
          </span>
        )}
        {tab !== 'settings' && (
          <button className="header-settings" title="设置" onClick={() => setTab('settings')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        )}
      </header>

      <main className="app-content">
        {renderContent()}
      </main>

      {tab !== 'settings' && (
        <>
          <div
            className="pane-resize-handle main-pane-resize-handle"
            title="调整主页宽度"
            onMouseDown={(event) => startPaneResize('main', event)}
          />
          <div className="action-bar">
            <button className={`action-btn ${running ? 'stop' : 'start'}`} onClick={handleStartStop}>
              {running ? (
                <>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <rect x="6" y="4" width="4" height="16" rx="1"/>
                    <rect x="14" y="4" width="4" height="16" rx="1"/>
                  </svg>
                  暂停服务
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  开始识别
                </>
              )}
            </button>
            <button
              className="action-btn secondary"
              onClick={handleRunOnce}
              disabled={running || recognizingOnce}
              title={running ? '持续识别运行中' : '执行一次识别'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <path d="M21 12a9 9 0 1 1-2.64-6.36"/>
                <path d="M21 3v6h-6"/>
                <path d="M10 8l6 4-6 4V8z"/>
              </svg>
              {recognizingOnce ? '识别中' : '单次识别'}
            </button>
          </div>

          <nav className="bottom-tabs">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={`bottom-tab ${(t.key === 'log' ? logDrawerOpen : tab === t.key) ? 'active' : ''}`}
                onClick={() => {
                  if (t.key === 'log') {
                    openLogDrawer();
                    return;
                  }
                  setTab(t.key);
                }}
              >
                <div className="bottom-tab-icon">
                  <TabIcon name={t.icon} active={(t.key === 'log' ? logDrawerOpen : tab === t.key)} />
                </div>
                <span className="bottom-tab-label">{t.label}</span>
              </button>
            ))}
          </nav>

          {logDrawerOpen && (
            <div className="log-drawer-layer">
              <aside className="log-drawer">
                <div
                  className="pane-resize-handle log-pane-resize-handle"
                  title="拖动分隔线调整日志宽度"
                  onMouseDown={(event) => startPaneResize('log', event)}
                />
                <div className="log-drawer-header">
                  <span>实时日志</span>
                  <button className="log-drawer-close" aria-label="关闭日志" onClick={() => setLogDrawerOpen(false)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M18 6L6 18"/>
                      <path d="M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
                <ChatMonitor events={events} />
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
