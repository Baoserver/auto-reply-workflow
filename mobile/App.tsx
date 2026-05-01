import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

const appLogo = require('./assets/app-logo.png');
const guardLogo = require('./assets/bot-tubiao.png');
const sleepGuardLogo = require('./assets/sleep-bot.png');

type Tab = 'home' | 'logs' | 'workflow' | 'connect';
type StatsRange = 'day' | 'month' | 'year' | 'total';
type LogFilter = 'all' | 'vision' | 'ocr' | 'reply' | 'escalation' | 'error';

interface AgentEvent {
  id?: string;
  ts?: string;
  type: string;
  data: any;
}

interface DashboardStats {
  keywordHits: number;
  visionRecognitions: number;
  aiReplies: number;
  escalations: number;
}

interface PendingReply {
  id: string;
  channel: string;
  content: string;
  workflow_mode?: string;
  sender?: string;
  source?: string;
  ts?: string;
}

interface DashboardResponse {
  ok: boolean;
  running: boolean;
  connections: { wechat: boolean; wecom: boolean };
  stats: Record<StatsRange, DashboardStats>;
  latestEvents: AgentEvent[];
  pendingReplies?: PendingReply[];
}

interface WorkflowConfig {
  wechat: { enabled: boolean };
  wecom: { enabled: boolean };
  workflow_mode: 'customer' | 'assistant';
  mode: 'assist' | 'auto';
  escalation: { keywords: string; max_unsolved_rounds: number };
  ocr: {
    enabled: boolean;
    fast_mode: boolean;
    check_interval: number;
    guard_enabled: boolean;
    guard_previous_check_interval: number;
    trigger_keywords: string;
  };
}

const STORAGE_KEYS = {
  serviceUrl: 'vision-cs-mobile-service-url',
  token: 'vision-cs-mobile-token',
};

const emptyStats: DashboardStats = {
  keywordHits: 0,
  visionRecognitions: 0,
  aiReplies: 0,
  escalations: 0,
};

const defaultDashboard: DashboardResponse = {
  ok: false,
  running: false,
  connections: { wechat: false, wecom: false },
  stats: {
    day: emptyStats,
    month: emptyStats,
    year: emptyStats,
    total: emptyStats,
  },
  latestEvents: [],
  pendingReplies: [],
};

const defaultWorkflowConfig: WorkflowConfig = {
  wechat: { enabled: true },
  wecom: { enabled: true },
  workflow_mode: 'customer',
  mode: 'auto',
  escalation: { keywords: '退款,投诉,经理,报警', max_unsolved_rounds: 2 },
  ocr: {
    enabled: true,
    fast_mode: true,
    check_interval: 3,
    guard_enabled: false,
    guard_previous_check_interval: 3,
    trigger_keywords: '怎么,如何,能不能,请问,价格,发货,退款,投诉,订单,物流,客服,帮助,问题',
  },
};

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function wsUrlFor(baseUrl: string, token: string) {
  const url = normalizeBaseUrl(baseUrl);
  return `${url.replace(/^http/i, 'ws')}/api/events/stream?token=${encodeURIComponent(token)}`;
}

function timeLabel(event: AgentEvent) {
  if (!event.ts) return '--:--';
  const date = new Date(event.ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function eventTitle(event: AgentEvent) {
  if (isRouteMatchedEvent(event)) return '路由';
  if (event.type === 'reply') return 'AI 回复';
  if (event.type === 'vision') return 'Vision 识别';
  if (event.type === 'ocr') return 'OCR';
  if (event.type === 'openclaw') return 'OpenClaw';
  if (event.type === 'escalation') return '转人工';
  if (event.type === 'status') return '服务状态';
  return event.type;
}

function eventBody(event: AgentEvent) {
  if (event.type === 'reply') return String(event.data?.content || '');
  if (event.type === 'log') return String(event.data?.message || '');
  if (event.type === 'status') return event.data?.state === 'running' ? '服务已启动' : '服务已停止';
  if (event.type === 'escalation') return String(event.data?.reason || '触发转人工');
  if (event.type === 'ocr') return (event.data?.new_lines || []).join('\n') || String(event.data?.window || '');
  if (event.type === 'vision') {
    const result = event.data?.result || {};
    const latest = result.latest_message || {};
    return latest.content || result.conversation_text || result.visible_text || '已完成视觉识别';
  }
  if (event.type === 'openclaw') return event.data?.reply || event.data?.stdout || 'OpenClaw 返回';
  return JSON.stringify(event.data || {});
}

function matchesFilter(event: AgentEvent, filter: LogFilter) {
  if (filter === 'all') return true;
  if (filter === 'error') return event.type === 'log' && event.data?.level === 'error';
  return event.type === filter;
}

function isRouteMatchedEvent(event: AgentEvent) {
  if (event.type !== 'log') return false;
  const message = String(event.data?.message || '');
  if (/OpenClaw assistant route matched/i.test(message)) return false;
  return /助手模式命中路由|OpenClaw route matched|route matched/i.test(message);
}

function isKeyHomeEvent(event: AgentEvent) {
  return event.type === 'vision' || event.type === 'reply' || isRouteMatchedEvent(event);
}

function statsForEvents(events: AgentEvent[]): Record<StatsRange, DashboardStats> {
  const next = {
    day: { ...emptyStats },
    month: { ...emptyStats },
    year: { ...emptyStats },
    total: { ...emptyStats },
  };
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const year = day.slice(0, 4);
  events.forEach((event) => {
    let key: keyof DashboardStats | null = null;
    if (isRouteMatchedEvent(event)) key = 'keywordHits';
    if (event.type === 'vision') key = 'visionRecognitions';
    if (event.type === 'reply') key = 'aiReplies';
    if (event.type === 'escalation') key = 'escalations';
    if (!key) return;
    const eventDay = new Date(event.ts || Date.now()).toISOString().slice(0, 10);
    next.total[key] += 1;
    if (eventDay.slice(0, 4) === year) next.year[key] += 1;
    if (eventDay.slice(0, 7) === month) next.month[key] += 1;
    if (eventDay === day) next.day[key] += 1;
  });
  return next;
}

function mergeStats(primary: DashboardStats, fallback: DashboardStats): DashboardStats {
  return {
    keywordHits: primary.keywordHits || fallback.keywordHits,
    visionRecognitions: primary.visionRecognitions || fallback.visionRecognitions,
    aiReplies: primary.aiReplies || fallback.aiReplies,
    escalations: primary.escalations || fallback.escalations,
  };
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [serviceUrl, setServiceUrl] = useState('');
  const [token, setToken] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [dashboard, setDashboard] = useState<DashboardResponse>(defaultDashboard);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [range, setRange] = useState<StatsRange>('day');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pendingReplies, setPendingReplies] = useState<PendingReply[]>([]);
  const [activePendingId, setActivePendingId] = useState('');
  const [pendingDraft, setPendingDraft] = useState('');
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfig>(defaultWorkflowConfig);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowSaving, setWorkflowSaving] = useState(false);
  const [guardSaving, setGuardSaving] = useState(false);
  const [lastHeartbeatAt, setLastHeartbeatAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastHeartbeatRef = useRef<number | null>(null);
  const heartbeatFailuresRef = useRef(0);
  const guardBumpMotion = useRef(new Animated.Value(0)).current;

  const markHeartbeat = useCallback(() => {
    const now = Date.now();
    heartbeatFailuresRef.current = 0;
    lastHeartbeatRef.current = now;
    setLastHeartbeatAt(now);
  }, []);

  const markHeartbeatFailure = useCallback(() => {
    heartbeatFailuresRef.current += 1;
    if (heartbeatFailuresRef.current >= 5) {
      setConnected(false);
    }
  }, []);

  const authedHeaders = useMemo(() => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }), [token]);

  const request = useCallback(async (path: string, options: RequestInit = {}) => {
    const base = normalizeBaseUrl(serviceUrl);
    if (!base) throw new Error('请先填写服务地址');
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.reason || `请求失败 ${response.status}`);
    return body;
  }, [serviceUrl]);

  const refreshDashboard = useCallback(async () => {
    if (!serviceUrl || !token) return;
    const body = await request('/api/dashboard', { headers: authedHeaders });
    setDashboard(body);
    setPendingReplies(Array.isArray(body.pendingReplies) ? body.pendingReplies : []);
    if (body.config && !guardSaving) {
      setWorkflowConfig({ ...defaultWorkflowConfig, ...(body.config || {}) });
    }
    if (Array.isArray(body.latestEvents) && body.latestEvents.length > 0) {
      setEvents((prev) => {
        const seen = new Set(prev.map((event) => event.id || `${event.ts}-${event.type}-${eventBody(event)}`));
        const additions = body.latestEvents.filter((event: AgentEvent) => !seen.has(event.id || `${event.ts}-${event.type}-${eventBody(event)}`));
        return additions.length > 0 ? [...prev, ...additions].slice(-100) : prev;
      });
    }
    setConnected(true);
    markHeartbeat();
  }, [authedHeaders, guardSaving, markHeartbeat, request, serviceUrl, token]);

  const refreshEvents = useCallback(async () => {
    if (!serviceUrl || !token) return;
    const body = await request('/api/events?limit=100', { headers: authedHeaders });
    setEvents(body.events || []);
  }, [authedHeaders, request, serviceUrl, token]);

  const refreshWorkflowConfig = useCallback(async () => {
    if (!serviceUrl || !token) return;
    setWorkflowLoading(true);
    try {
      const body = await request('/api/config', { headers: authedHeaders });
      setWorkflowConfig({ ...defaultWorkflowConfig, ...(body.config || {}) });
    } catch (error) {
      Alert.alert('读取失败', String(error instanceof Error ? error.message : error));
    } finally {
      setWorkflowLoading(false);
    }
  }, [authedHeaders, request, serviceUrl, token]);

  const updateWorkflowConfig = (patch: Partial<WorkflowConfig>) => {
    setWorkflowConfig((prev) => ({ ...prev, ...patch }));
  };

  const updateWorkflowOcr = (patch: Partial<WorkflowConfig['ocr']>) => {
    setWorkflowConfig((prev) => ({ ...prev, ocr: { ...prev.ocr, ...patch } }));
  };

  const getGuardConfig = (config: WorkflowConfig, enabled: boolean): WorkflowConfig => {
    if (enabled) {
      return {
        ...config,
        ocr: {
          ...config.ocr,
          guard_enabled: true,
          guard_previous_check_interval: config.ocr.check_interval,
          check_interval: 60,
        },
      };
    }
    return {
      ...config,
      ocr: {
        ...config.ocr,
        guard_enabled: false,
        check_interval: config.ocr.guard_previous_check_interval || 3,
      },
    };
  };

  const playGuardBump = () => {
    guardBumpMotion.stopAnimation();
    guardBumpMotion.setValue(0);
    Animated.timing(guardBumpMotion, {
      toValue: 1,
      duration: 2000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start(() => guardBumpMotion.setValue(0));
  };

  const playGuardBumpAfterLayout = () => {
    requestAnimationFrame(playGuardBump);
  };

  const toggleGuardFromHome = async () => {
    if (!token) {
      Alert.alert('未连接', '请先连接桌面服务后再切换值守');
      return;
    }
    if (guardSaving) return;
    const previousConfig = workflowConfig;
    const nextEnabled = !workflowConfig.ocr.guard_enabled;
    const nextConfig = getGuardConfig(previousConfig, nextEnabled);
    setGuardSaving(true);
    setWorkflowConfig(nextConfig);
    playGuardBumpAfterLayout();
    try {
      const body = await request('/api/config', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({ config: nextConfig }),
      });
      setWorkflowConfig({ ...defaultWorkflowConfig, ...(body.config || nextConfig) });
      await refreshDashboard();
    } catch (error) {
      setWorkflowConfig(previousConfig);
      playGuardBumpAfterLayout();
      Alert.alert('切换失败', String(error instanceof Error ? error.message : error));
    } finally {
      setGuardSaving(false);
    }
  };

  useEffect(() => () => {
    guardBumpMotion.stopAnimation();
  }, [guardBumpMotion]);

  const saveWorkflowConfig = async () => {
    setWorkflowSaving(true);
    try {
      const body = await request('/api/config', {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({ config: workflowConfig }),
      });
      setWorkflowConfig({ ...defaultWorkflowConfig, ...(body.config || workflowConfig) });
      await refreshDashboard();
      Alert.alert('已保存', '工作流设置已同步到桌面端');
    } catch (error) {
      Alert.alert('保存失败', String(error instanceof Error ? error.message : error));
    } finally {
      setWorkflowSaving(false);
    }
  };

  const connectStream = useCallback(() => {
    if (!serviceUrl || !token) return;
    wsRef.current?.close();
    const ws = new WebSocket(wsUrlFor(serviceUrl, token));
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      markHeartbeat();
    };
    ws.onclose = () => markHeartbeatFailure();
    ws.onerror = () => markHeartbeatFailure();
    ws.onmessage = (message) => {
      try {
        markHeartbeat();
        const payload = JSON.parse(String(message.data));
        if (payload.type === 'event' && payload.event) {
          setEvents((prev) => [...prev.slice(-99), payload.event]);
          if (payload.event.type === 'pending_reply' && payload.event.data?.id) {
            const item = payload.event.data as PendingReply;
            setPendingReplies((prev) => {
              const withoutSame = prev.filter((reply) => reply.id !== item.id);
              return [...withoutSame, item].slice(-10);
            });
            setActivePendingId(item.id);
            setPendingDraft(item.content || '');
          }
          if (payload.event.type === 'pending_reply_cleared' && payload.event.data?.id) {
            const clearedId = String(payload.event.data.id);
            setPendingReplies((prev) => prev.filter((reply) => reply.id !== clearedId));
            setActivePendingId((current) => {
              if (current !== clearedId) return current;
              setPendingDraft('');
              return '';
            });
          }
          refreshDashboard().catch(() => {});
        }
        if (payload.type === 'config' && payload.config && !guardSaving) {
          setWorkflowConfig({ ...defaultWorkflowConfig, ...(payload.config || {}) });
        }
      } catch {}
    };
  }, [guardSaving, markHeartbeatFailure, refreshDashboard, serviceUrl, token]);

  useEffect(() => {
    const load = async () => {
      const [storedUrl, storedToken] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.serviceUrl),
        AsyncStorage.getItem(STORAGE_KEYS.token),
      ]);
      if (storedUrl) setServiceUrl(storedUrl);
      if (storedToken) setToken(storedToken);
    };
    load();
  }, []);

  useEffect(() => {
    if (!serviceUrl || !token) return;
    const heartbeat = async () => {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timeout')), 5000));
      await Promise.race([refreshDashboard(), timeout]);
    };
    heartbeat().catch(markHeartbeatFailure);
    refreshEvents().catch(() => {});
    refreshWorkflowConfig().catch(() => {});
    connectStream();
    const timer = setInterval(() => {
      heartbeat().catch(markHeartbeatFailure);
    }, 8000);
    return () => {
      clearInterval(timer);
      wsRef.current?.close();
    };
  }, [connectStream, markHeartbeatFailure, refreshDashboard, refreshEvents, refreshWorkflowConfig, serviceUrl, token]);

  const saveAddress = async () => {
    const next = normalizeBaseUrl(serviceUrl);
    setServiceUrl(next);
    await AsyncStorage.setItem(STORAGE_KEYS.serviceUrl, next);
    Alert.alert('已保存', '服务地址已更新');
  };

  const pairDevice = async () => {
    setLoading(true);
    try {
      const body = await request('/api/pair/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pairCode, deviceName: 'Mobile App' }),
      });
      setToken(body.token);
      await AsyncStorage.setItem(STORAGE_KEYS.token, body.token);
      await AsyncStorage.setItem(STORAGE_KEYS.serviceUrl, normalizeBaseUrl(serviceUrl));
      setPairCode('');
      Alert.alert('配对成功', '手机端已连接本地智回复服务');
    } catch (error) {
      Alert.alert('配对失败', String(error instanceof Error ? error.message : error));
    } finally {
      setLoading(false);
    }
  };

  const controlAgent = async (action: 'start' | 'stop' | 'run-once') => {
    setLoading(true);
    try {
      await request(`/api/agent/${action}`, { method: 'POST', headers: authedHeaders });
      await refreshDashboard();
      await refreshEvents();
    } catch (error) {
      Alert.alert('操作失败', String(error instanceof Error ? error.message : error));
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    setToken('');
    setConnected(false);
    wsRef.current?.close();
    await AsyncStorage.removeItem(STORAGE_KEYS.token);
  };

  useEffect(() => {
    if (pendingReplies.length === 0) {
      setActivePendingId('');
      setPendingDraft('');
      return;
    }
    const current = pendingReplies.find((reply) => reply.id === activePendingId);
    if (current) return;
    const latest = pendingReplies[pendingReplies.length - 1];
    setActivePendingId(latest.id);
    setPendingDraft(latest.content || '');
  }, [activePendingId, pendingReplies]);

  useEffect(() => {
    if (tab === 'workflow') {
      refreshWorkflowConfig().catch(() => {});
    }
  }, [refreshWorkflowConfig, tab]);

  const activePendingReply = pendingReplies.find((reply) => reply.id === activePendingId) || pendingReplies[0] || null;

  const removePendingReply = useCallback((id: string) => {
    setPendingReplies((prev) => prev.filter((reply) => reply.id !== id));
    if (activePendingId === id) {
      setActivePendingId('');
      setPendingDraft('');
    }
  }, [activePendingId]);

  const confirmPendingReply = async () => {
    if (!activePendingReply || !pendingDraft.trim() || pendingSubmitting) return;
    setPendingSubmitting(true);
    try {
      await request(`/api/pending-replies/${encodeURIComponent(activePendingReply.id)}/confirm`, {
        method: 'POST',
        headers: authedHeaders,
        body: JSON.stringify({ content: pendingDraft.trim() }),
      });
      removePendingReply(activePendingReply.id);
      await refreshDashboard();
      await refreshEvents();
      Alert.alert('已发送', '待发送信息已由桌面端发送');
    } catch (error) {
      Alert.alert('发送失败', String(error instanceof Error ? error.message : error));
    } finally {
      setPendingSubmitting(false);
    }
  };

  const cancelPendingReply = async () => {
    if (!activePendingReply || pendingSubmitting) return;
    setPendingSubmitting(true);
    try {
      await request(`/api/pending-replies/${encodeURIComponent(activePendingReply.id)}/cancel`, {
        method: 'POST',
        headers: authedHeaders,
      });
      removePendingReply(activePendingReply.id);
      await refreshDashboard();
      Alert.alert('已取消', '这条待发送信息已丢弃');
    } catch (error) {
      Alert.alert('取消失败', String(error instanceof Error ? error.message : error));
    } finally {
      setPendingSubmitting(false);
    }
  };

  const localStats = useMemo(() => statsForEvents(events), [events]);
  const visibleStats = mergeStats(dashboard.stats?.[range] || emptyStats, localStats[range]);
  const visibleEvents = events.filter((event) => matchesFilter(event, filter)).slice().reverse();
  const keyEvents = events.filter(isKeyHomeEvent);
  const latestKeyEvents = keyEvents.slice(-6);
  const showGuardActiveIcon = tab === 'home' && workflowConfig.ocr.guard_enabled;
  const showSleepGuardIcon = !workflowConfig.ocr.guard_enabled;
  const guardBumpStyle = {
    transform: [
      {
        translateY: guardBumpMotion.interpolate({
          inputRange: [0, 0.32, 0.56, 0.76, 1],
          outputRange: [0, -16, 14, -5, 0],
        }),
      },
      {
        scaleX: guardBumpMotion.interpolate({
          inputRange: [0, 0.32, 0.56, 0.76, 1],
          outputRange: [1, 1.18, 1.08, 1.05, 1],
        }),
      },
      {
        scaleY: guardBumpMotion.interpolate({
          inputRange: [0, 0.32, 0.56, 0.76, 1],
          outputRange: [1, 1.18, 0.86, 1.06, 1],
        }),
      },
    ],
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View style={styles.brandGroup}>
          <Image source={appLogo} style={styles.logo} />
          <Text style={styles.brand}>智回复APP</Text>
        </View>
        <View style={[styles.statusPill, connected ? styles.online : styles.offline]}>
          <Text style={styles.statusText}>{connected ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>
      </View>

      {activePendingReply && (
        <View style={styles.pendingCard}>
          <View style={styles.pendingHeader}>
            <View>
              <Text style={styles.pendingKicker}>待发送信息</Text>
              <Text style={styles.pendingTitle}>{activePendingReply.workflow_mode === 'assistant' ? '助手模式' : '客服模式'}</Text>
            </View>
            <Text style={styles.pendingBadge}>{pendingReplies.length} 条</Text>
          </View>
          <Text style={styles.pendingMeta}>
            {(activePendingReply.channel || '企业微信')} · {(activePendingReply.sender || activePendingReply.source || 'AI 回复')}
          </Text>
          <TextInput
            value={pendingDraft}
            onChangeText={setPendingDraft}
            multiline
            textAlignVertical="top"
            style={styles.pendingInput}
          />
          <View style={styles.pendingActions}>
            <Pressable style={[styles.pendingButton, styles.pendingCancel]} onPress={cancelPendingReply} disabled={pendingSubmitting}>
              <Text style={styles.pendingButtonText}>取消</Text>
            </Pressable>
            <Pressable
              style={[styles.pendingButton, styles.pendingConfirm, (!pendingDraft.trim() || pendingSubmitting) && styles.pendingDisabled]}
              onPress={confirmPendingReply}
              disabled={!pendingDraft.trim() || pendingSubmitting}
            >
              <Text style={styles.pendingButtonText}>{pendingSubmitting ? '处理中' : '确认发送'}</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.pageHost}>
      {tab === 'home' && (
        <ScrollView style={styles.scroller} contentContainerStyle={styles.content}>
          <View style={[styles.homeHero, dashboard.running ? styles.homeHeroOn : styles.homeHeroOff]}>
            <View>
              <Text style={styles.homeKicker}>AUTO REPLY OPS</Text>
              <Text style={styles.homeHeroTitle}>{dashboard.running ? '托管运行中' : '等待启动'}</Text>
              <Text style={styles.homeHeroCopy}>
                {dashboard.running ? '正在监听窗口变化、OCR 与回复链路。' : '点击底部按钮开始识别微信与企业微信。'}
              </Text>
            </View>
            <View style={styles.homeHeroStamp}>
              <Text style={styles.homeHeroStampText}>{dashboard.running ? 'ON' : 'OFF'}</Text>
            </View>
          </View>

          <View style={styles.homeMatrix}>
            <View style={styles.homeStatsCard}>
              <View style={styles.homeStatsTabs}>
                {(['day', 'month', 'year', 'total'] as StatsRange[]).map((item) => (
                  <Pressable key={item} style={[styles.homeStatsTab, range === item && styles.homeStatsTabActive]} onPress={() => setRange(item)}>
                    <Text style={[styles.homeStatsTabText, range === item && styles.homeStatsTabTextActive]}>
                      {{ day: '日', month: '月', year: '年', total: '总' }[item]}
                    </Text>
                    <Text style={[styles.homeStatsTabHint, range === item && styles.homeStatsTabTextActive]}>
                      {{ day: '今日', month: '本月', year: '今年', total: '累计' }[item]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.homeStatGrid}>
                <StatCard tone="keyword" label="关键字命中" value={visibleStats.keywordHits} hint="路由触发" />
                <StatCard tone="vision" label="Vision识别" value={visibleStats.visionRecognitions} hint="视觉分析" />
                <StatCard tone="reply" label="AI回复" value={visibleStats.aiReplies} hint="已生成" />
                <StatCard tone="escalation" label="转人工" value={visibleStats.escalations} hint={visibleStats.escalations > 0 ? '需关注' : '暂无'} />
              </View>
              {showGuardActiveIcon && (
                <Animated.View style={[styles.guardActiveClip, guardBumpStyle]}>
                  <Pressable
                    onPress={toggleGuardFromHome}
                    disabled={guardSaving}
                    hitSlop={10}
                    style={({ pressed }) => [
                      styles.guardActiveButton,
                      pressed && !guardSaving && styles.guardTogglePressed,
                      guardSaving && styles.guardToggleSaving,
                    ]}
                  >
                    <Image source={guardLogo} style={styles.guardActiveImage} />
                  </Pressable>
                </Animated.View>
              )}
            </View>

            <View style={styles.homeChannelCard}>
              <Text style={styles.blackLabel}>设备连接</Text>
              <ChannelRow label="微信" active={dashboard.connections.wechat} />
              <ChannelRow label="企业微信" active={dashboard.connections.wecom} />
            </View>
          </View>

          <View style={styles.homeMessageBoard}>
            <View style={styles.homeBoardHeader}>
              <Text style={styles.homeBoardTitle}>关键日志</Text>
              <Text style={styles.homeBoardCount}>{keyEvents.length} 条关键事件</Text>
            </View>
            {latestKeyEvents.length === 0 ? (
              <Text style={styles.chatEmpty}>命中路由、Vision 识别和 AI 回复会显示在这里</Text>
            ) : (
              latestKeyEvents.map((event) => <EventRow key={event.id || `${event.ts}-${event.type}`} event={event} compact />)
            )}
          </View>
        </ScrollView>
      )}

      {tab === 'logs' && (
        <View style={styles.logsPage}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
            {(['all', 'vision', 'ocr', 'reply', 'escalation', 'error'] as LogFilter[]).map((item) => (
              <Pressable key={item} style={[styles.filterButton, filter === item && styles.filterActive]} onPress={() => setFilter(item)}>
                <Text style={[styles.filterText, filter === item && styles.filterTextActive]}>
                  {{ all: '全部', vision: 'Vision', ocr: 'OCR', reply: '回复', escalation: '转人工', error: '错误' }[item]}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <FlatList
            style={styles.logsList}
            contentContainerStyle={styles.logsListContent}
            data={visibleEvents}
            keyExtractor={(item, index) => item.id || `${item.ts}-${item.type}-${index}`}
            renderItem={({ item }) => <EventRow event={item} />}
            ListEmptyComponent={<Text style={styles.empty}>暂无日志</Text>}
          />
        </View>
      )}

      {tab === 'workflow' && (
        <ScrollView style={styles.scroller} contentContainerStyle={styles.content}>
          <SectionTitle title="工作流设置" />
          <View style={styles.workflowCard}>
            <Text style={styles.blackLabel}>回复策略</Text>
            <ToggleRow
              label="微信"
              value={workflowConfig.wechat.enabled}
              onValueChange={(enabled) => updateWorkflowConfig({ wechat: { enabled } })}
            />
            <ToggleRow
              label="企业微信"
              value={workflowConfig.wecom.enabled}
              onValueChange={(enabled) => updateWorkflowConfig({ wecom: { enabled } })}
            />
          </View>

          <View style={styles.workflowCard}>
            <Text style={styles.blackLabel}>工作模式</Text>
            <Segmented
              value={workflowConfig.workflow_mode}
              options={[
                { value: 'customer', label: '客服模式' },
                { value: 'assistant', label: '助手模式' },
              ]}
              onChange={(value) => updateWorkflowConfig({ workflow_mode: value as WorkflowConfig['workflow_mode'] })}
            />
            <Text style={styles.workflowHint}>
              {workflowConfig.workflow_mode === 'assistant' ? '关键词触发完整上下文工作流' : '识别客户新消息并回复'}
            </Text>

            <Text style={styles.workflowSubLabel}>回复模式</Text>
            <Segmented
              value={workflowConfig.mode}
              options={[
                { value: 'assist', label: '辅助' },
                { value: 'auto', label: '托管' },
              ]}
              onChange={(value) => updateWorkflowConfig({ mode: value as WorkflowConfig['mode'] })}
            />
          </View>

          <View style={styles.workflowCard}>
            <Text style={styles.blackLabel}>OCR</Text>
            <ToggleRow
              label="启用本地 OCR"
              value={workflowConfig.ocr.enabled}
              onValueChange={(enabled) => updateWorkflowOcr({ enabled })}
            />
            <ToggleRow
              label="快速模式"
              value={workflowConfig.ocr.fast_mode}
              onValueChange={(fast_mode) => updateWorkflowOcr({ fast_mode })}
            />
            <Text style={styles.label}>检测间隔（秒）</Text>
            <TextInput
              value={String(workflowConfig.ocr.guard_enabled ? 60 : workflowConfig.ocr.check_interval)}
              onChangeText={(value) => updateWorkflowOcr({ check_interval: Number(value) || 3 })}
              keyboardType="number-pad"
              editable={!workflowConfig.ocr.guard_enabled}
              style={[styles.input, workflowConfig.ocr.guard_enabled && styles.inputDisabled]}
            />
            {workflowConfig.ocr.guard_enabled && (
              <Text style={styles.workflowHint}>值守已开启，检测间隔固定为 60 秒</Text>
            )}
            <Text style={styles.label}>触发关键词</Text>
            <TextInput
              value={workflowConfig.ocr.trigger_keywords}
              onChangeText={(trigger_keywords) => updateWorkflowOcr({ trigger_keywords })}
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.workflowTextArea]}
            />
          </View>

          {workflowConfig.workflow_mode === 'customer' && (
            <View style={styles.workflowCard}>
              <Text style={styles.blackLabel}>客服升级</Text>
              <Text style={styles.label}>升级关键词</Text>
              <TextInput
                value={workflowConfig.escalation.keywords}
                onChangeText={(keywords) => updateWorkflowConfig({ escalation: { ...workflowConfig.escalation, keywords } })}
                style={styles.input}
              />
              <Text style={styles.label}>未解决轮数上限</Text>
              <TextInput
                value={String(workflowConfig.escalation.max_unsolved_rounds)}
                onChangeText={(value) => updateWorkflowConfig({ escalation: { ...workflowConfig.escalation, max_unsolved_rounds: Number(value) || 2 } })}
                keyboardType="number-pad"
                style={styles.input}
              />
            </View>
          )}

          <Pressable style={styles.primaryActionWide} onPress={saveWorkflowConfig} disabled={workflowSaving || workflowLoading || !token}>
            {workflowSaving ? <ActivityIndicator color="#171717" /> : <Text style={styles.primaryActionText}>{workflowLoading ? '读取中' : '保存工作流'}</Text>}
          </Pressable>
        </ScrollView>
      )}

      {tab === 'connect' && (
        <ScrollView style={styles.scroller} contentContainerStyle={styles.content}>
          <SectionTitle title="连接桌面服务" />
          <Text style={styles.label}>服务地址</Text>
          <TextInput
            value={serviceUrl}
            onChangeText={setServiceUrl}
            placeholder="http://192.168.1.12:47831"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable style={styles.secondaryActionWide} onPress={saveAddress}>
            <Text style={styles.secondaryActionText}>保存地址</Text>
          </Pressable>

          <Text style={styles.label}>配对码</Text>
          <TextInput
            value={pairCode}
            onChangeText={(v) => setPairCode(v.toUpperCase())}
            placeholder="8位字母数字，如 A3K7X9M2"
            autoCapitalize="characters"
            maxLength={8}
            style={styles.input}
          />
          <Pressable style={styles.primaryActionWide} onPress={pairDevice} disabled={loading || !serviceUrl || !pairCode}>
            {loading ? <ActivityIndicator color="#171717" /> : <Text style={styles.primaryActionText}>完成配对</Text>}
          </Pressable>

          <View style={styles.connectionCard}>
            <Text style={styles.connectionTitle}>{token ? '已保存访问 Token' : '未配对'}</Text>
            <Text style={styles.connectionCopy}>{token ? '手机端可查看状态、日志并控制服务。' : '先在桌面端生成配对码，再回到这里输入。'}</Text>
            {token && (
              <Pressable style={styles.dangerButton} onPress={disconnect}>
                <Text style={styles.dangerText}>清除本机 Token</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}
      </View>

      {tab !== 'connect' && (
        <>
        <View style={styles.assetPreload} pointerEvents="none">
          <Image source={sleepGuardLogo} style={styles.assetPreloadImage} />
          <Image source={guardLogo} style={styles.assetPreloadImage} />
        </View>
        {showSleepGuardIcon && (
        <Animated.View style={[styles.guardToggleWrap, guardBumpStyle]}>
          <Pressable
            onPress={toggleGuardFromHome}
            disabled={guardSaving || tab !== 'home'}
            hitSlop={10}
            style={({ pressed }) => [
              styles.guardToggle,
              pressed && !guardSaving && tab === 'home' && styles.guardTogglePressed,
              guardSaving && styles.guardToggleSaving,
              tab !== 'home' && styles.guardToggleDecorative,
            ]}
          >
            <Image source={sleepGuardLogo} style={styles.guardToggleImage} />
          </Pressable>
        </Animated.View>
        )}
        <View style={styles.actionBar}>
          <Pressable
            style={[
              styles.actionButton,
              dashboard.running ? styles.actionStop : styles.actionStart,
              (loading || !token || !connected) && styles.actionDisabled,
            ]}
            onPress={() => controlAgent(dashboard.running ? 'stop' : 'start')}
            disabled={loading || !token || !connected}
          >
            <Text style={styles.actionButtonText}>{dashboard.running ? '暂停服务' : '开始识别'}</Text>
          </Pressable>
          <Pressable
            style={[
              styles.actionButton,
              styles.actionSecondary,
              (loading || dashboard.running || !token || !connected) && styles.actionDisabled,
            ]}
            onPress={() => controlAgent('run-once')}
            disabled={loading || dashboard.running || !token || !connected}
          >
            <Text style={styles.actionButtonText}>{loading ? '识别中' : '单次识别'}</Text>
          </Pressable>
        </View>
        </>
      )}

      <View style={styles.tabs}>
        <TabButton label="首页" active={tab === 'home'} onPress={() => setTab('home')} />
        <TabButton label="工作流" active={tab === 'workflow'} onPress={() => setTab('workflow')} />
        <TabButton label="日志" active={tab === 'logs'} onPress={() => setTab('logs')} />
        <TabButton label="连接" active={tab === 'connect'} onPress={() => setTab('connect')} />
      </View>
    </SafeAreaView>
  );
}

function ChannelRow({ label, active }: { label: string; active: boolean }) {
  return (
    <View style={styles.channelRow}>
      <Text style={styles.channelName}>{label}</Text>
      <Text style={[styles.channelBadge, active ? styles.channelOnline : styles.channelOffline]}>{active ? '已连接' : '未连接'}</Text>
    </View>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: 'keyword' | 'vision' | 'reply' | 'escalation' }) {
  const toneStyle = {
    keyword: styles.statKeyword,
    vision: styles.statVision,
    reply: styles.statReply,
    escalation: styles.statEscalation,
  }[tone];
  return (
    <View style={[styles.statCard, toneStyle]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statHint}>{hint}</Text>
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function ToggleRow({ label, value, hint, onValueChange }: { label: string; value: boolean; hint?: string; onValueChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {hint ? <Text style={styles.workflowHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#D9D1C3', true: '#B8E9C7' }}
        thumbColor={value ? '#36B37E' : '#FFFDF7'}
        ios_backgroundColor="#D9D1C3"
      />
    </View>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return (
    <View style={styles.segmented}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          style={[styles.segmentButton, value === option.value && styles.segmentButtonActive]}
          onPress={() => onChange(option.value)}
        >
          <Text style={[styles.segmentText, value === option.value && styles.segmentTextActive]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function EventRow({ event, compact = false }: { event: AgentEvent; compact?: boolean }) {
  const variant = event.type === 'reply' ? styles.eventSent : event.type === 'status' ? styles.eventSystem : styles.eventReceived;
  const isLog = event.type === 'log';
  return (
    <View style={[styles.eventRow, variant, compact && styles.eventCompact]}>
      <View style={[
        styles.eventBubble,
        event.type === 'reply' && styles.eventBubbleAi,
        event.type === 'escalation' && styles.eventBubbleEscalation,
        isLog && event.data?.level === 'error' && styles.eventBubbleError,
        isLog && event.data?.level !== 'error' && styles.eventBubbleWarn,
      ]}>
      <View style={styles.eventHeader}>
          <Text style={[
            styles.eventType,
            event.type === 'vision' && styles.eventTagVision,
            event.type === 'ocr' && styles.eventTagOcr,
            event.type === 'reply' && styles.eventTagAi,
            event.type === 'openclaw' && styles.eventTagOpenClaw,
          ]}>{eventTitle(event)}</Text>
        <Text style={styles.eventTime}>{timeLabel(event)}</Text>
      </View>
        <Text style={styles.eventBody} numberOfLines={compact ? 2 : 8}>{eventBody(event)}</Text>
      </View>
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tabButton, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F5F7' },
  header: { height: 62, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 2, borderColor: '#171717', backgroundColor: '#FFFDF7' },
  brandGroup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 34, height: 34, borderRadius: 10, borderWidth: 2, borderColor: '#171717', backgroundColor: '#FFF3D8' },
  brand: { fontSize: 21, fontWeight: '900', color: '#171717' },
  statusPill: { borderWidth: 2, borderColor: '#171717', paddingHorizontal: 10, paddingVertical: 5, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 2, height: 2 }, shadowRadius: 0 },
  online: { backgroundColor: '#C6F6D5' },
  offline: { backgroundColor: '#F3E7D3' },
  statusText: { fontSize: 11, fontWeight: '900', color: '#171717' },
  pendingCard: { margin: 12, marginBottom: 8, padding: 12, backgroundColor: '#FFFDF7', borderWidth: 3, borderColor: '#171717', borderRadius: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 4, height: 4 }, shadowRadius: 0, gap: 8 },
  pendingHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  pendingKicker: { fontSize: 10, fontWeight: '900', color: '#7B715F' },
  pendingTitle: { fontSize: 20, lineHeight: 23, fontWeight: '900', color: '#171717' },
  pendingBadge: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#F7D748', borderWidth: 2, borderColor: '#171717', borderRadius: 4, overflow: 'hidden', fontSize: 11, fontWeight: '900', color: '#171717' },
  pendingMeta: { fontSize: 11, lineHeight: 15, fontWeight: '900', color: '#5F5747' },
  pendingInput: { minHeight: 104, maxHeight: 170, padding: 10, backgroundColor: '#EFE7D8', borderWidth: 3, borderColor: '#171717', borderRadius: 6, color: '#171717', fontWeight: '800', lineHeight: 19 },
  pendingActions: { flexDirection: 'row', gap: 10 },
  pendingButton: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 2, height: 2 }, shadowRadius: 0 },
  pendingCancel: { backgroundColor: '#FFFFFF' },
  pendingConfirm: { backgroundColor: '#C9F2D1' },
  pendingDisabled: { opacity: 0.52 },
  pendingButtonText: { fontWeight: '900', color: '#171717', fontSize: 13 },
  pageHost: { flex: 1, minHeight: 0 },
  scroller: { flex: 1 },
  content: { padding: 14, gap: 12, paddingBottom: 18 },
  homeHero: { minHeight: 132, padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', borderWidth: 3, borderColor: '#171717', borderRadius: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 4, height: 4 }, shadowRadius: 0, transform: [{ rotate: '-0.45deg' }] },
  homeHeroOn: { backgroundColor: '#F7D748' },
  homeHeroOff: { backgroundColor: '#F4C7A1' },
  homeKicker: { alignSelf: 'flex-start', backgroundColor: '#171717', color: '#FFFFFF', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, fontSize: 9, fontWeight: '900', marginBottom: 8 },
  homeHeroTitle: { fontSize: 28, fontWeight: '900', color: '#171717', marginBottom: 5, lineHeight: 30 },
  homeHeroCopy: { fontSize: 12, color: '#534A3D', maxWidth: 245, lineHeight: 17, fontWeight: '800' },
  homeHeroStamp: { borderWidth: 3, borderColor: '#171717', backgroundColor: '#FFFDF7', borderRadius: 6, paddingHorizontal: 11, paddingVertical: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  homeHeroStampText: { fontSize: 20, fontWeight: '900', color: '#171717' },
  homeMatrix: { gap: 10, alignItems: 'stretch' },
  homeStatsCard: { position: 'relative', minHeight: 232, flexDirection: 'row', overflow: 'visible', backgroundColor: '#FFFDF7', borderWidth: 3, borderColor: '#171717', borderRadius: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  homeStatsTabs: { width: 58, backgroundColor: '#EFE7D8', borderRightWidth: 3, borderColor: '#171717' },
  homeStatsTab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderColor: '#171717', paddingVertical: 5 },
  homeStatsTabActive: { backgroundColor: '#FFFDF7' },
  homeStatsTabText: { fontSize: 18, lineHeight: 20, fontWeight: '900', color: '#6B6255' },
  homeStatsTabHint: { fontSize: 9, lineHeight: 11, fontWeight: '900', color: '#6B6255', marginTop: 1 },
  homeStatsTabTextActive: { color: '#171717' },
  homeStatGrid: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignContent: 'space-between', padding: 8 },
  statCard: { width: '48%', minHeight: 102, borderWidth: 3, borderColor: '#171717', borderRadius: 8, padding: 8, justifyContent: 'space-between', marginBottom: 8 },
  statKeyword: { backgroundColor: '#D9C8FF' },
  statVision: { backgroundColor: '#FFEBA8' },
  statReply: { backgroundColor: '#C9F2D1' },
  statEscalation: { backgroundColor: '#F7B6AB' },
  statLabel: { alignSelf: 'flex-start', backgroundColor: '#171717', color: '#FFFFFF', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, fontSize: 9, fontWeight: '900', overflow: 'hidden' },
  statValue: { fontSize: 26, lineHeight: 28, fontWeight: '900', color: '#171717' },
  statHint: { fontSize: 9, lineHeight: 11, color: '#62594D', fontWeight: '900' },
  homeChannelCard: { minHeight: 124, backgroundColor: '#FFEBA8', borderWidth: 3, borderColor: '#171717', borderRadius: 8, padding: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0, transform: [{ rotate: '0.45deg' }] },
  blackLabel: { alignSelf: 'flex-start', backgroundColor: '#171717', color: '#FFFFFF', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, fontSize: 9, fontWeight: '900', overflow: 'hidden', marginBottom: 8 },
  channelRow: { paddingVertical: 8, borderBottomWidth: 2, borderColor: '#171717', gap: 5 },
  channelName: { fontSize: 11, fontWeight: '900', color: '#171717' },
  channelBadge: { alignSelf: 'flex-start', borderWidth: 2, borderColor: '#171717', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 2, height: 2 }, shadowRadius: 0, fontSize: 9, fontWeight: '900', overflow: 'hidden' },
  channelOnline: { backgroundColor: '#36B37E', color: '#FFFFFF' },
  channelOffline: { backgroundColor: '#FFFDF7', color: '#171717' },
  homeMessageBoard: { backgroundColor: '#FFFDF7', borderWidth: 3, borderColor: '#171717', borderRadius: 8, padding: 12, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 4, height: 4 }, shadowRadius: 0, gap: 10 },
  homeBoardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  homeBoardTitle: { fontSize: 18, fontWeight: '900', color: '#171717' },
  homeBoardCount: { backgroundColor: '#F7D748', borderWidth: 2, borderColor: '#171717', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 4, fontSize: 11, fontWeight: '900', color: '#171717', overflow: 'hidden' },
  chatEmpty: { borderWidth: 2, borderColor: '#171717', borderRadius: 6, padding: 14, color: '#6B6255', fontWeight: '800', textAlign: 'center', backgroundColor: '#F7F0E4' },
  actionBar: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, borderTopWidth: 2, borderColor: '#171717', backgroundColor: '#FFFDF7', overflow: 'visible' },
  assetPreload: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' },
  assetPreloadImage: { width: 1, height: 1 },
  guardToggleWrap: { position: 'absolute', right: -46, bottom: 86, width: 188, height: 188, zIndex: 30 },
  guardToggle: { width: 188, height: 188, alignItems: 'center', justifyContent: 'center' },
  guardActiveClip: { position: 'absolute', right: -25, top: -96, width: 138, height: 138, overflow: 'visible', zIndex: 6 },
  guardActiveButton: { width: 138, height: 138, alignItems: 'center', justifyContent: 'center' },
  guardActiveImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  guardTogglePressed: { transform: [{ translateY: -2 }, { rotate: '-3deg' }] },
  guardToggleSaving: { opacity: 1 },
  guardToggleDecorative: { opacity: 1 },
  guardToggleImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  actionButton: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  actionStart: { backgroundColor: '#F7D748' },
  actionStop: { backgroundColor: '#F7B6AB' },
  actionSecondary: { backgroundColor: '#FFFFFF' },
  actionDisabled: { backgroundColor: '#D9D1C3', opacity: 0.58 },
  actionButtonText: { fontWeight: '900', color: '#171717', fontSize: 14 },
  primaryActionWide: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#F7D748', shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  primaryActionText: { fontWeight: '900', color: '#171717' },
  secondaryActionWide: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#FFFFFF', marginBottom: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  secondaryActionText: { fontWeight: '900', color: '#171717' },
  sectionTitle: { fontSize: 16, fontWeight: '900', color: '#171717', marginTop: 4 },
  workflowCard: { backgroundColor: '#FFFDF7', borderWidth: 3, borderColor: '#171717', borderRadius: 8, padding: 12, gap: 10, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  toggleRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 4, borderBottomWidth: 2, borderColor: '#E1D7C6' },
  toggleCopy: { flex: 1, minWidth: 0 },
  toggleLabel: { fontSize: 14, fontWeight: '900', color: '#171717' },
  workflowHint: { color: '#6B6255', fontSize: 11, lineHeight: 15, fontWeight: '800', marginTop: 4 },
  workflowSubLabel: { color: '#171717', fontWeight: '900', marginTop: 6 },
  segmented: { flexDirection: 'row', gap: 8 },
  segmentButton: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 3, borderColor: '#171717', borderRadius: 6 },
  segmentButtonActive: { backgroundColor: '#F7D748' },
  segmentText: { fontSize: 13, fontWeight: '900', color: '#6B6255' },
  segmentTextActive: { color: '#171717' },
  inputDisabled: { backgroundColor: '#E4DED3', color: '#7B715F' },
  workflowTextArea: { minHeight: 92, paddingTop: 10 },
  eventRow: { maxWidth: '86%', marginBottom: 12 },
  eventReceived: { alignSelf: 'flex-start' },
  eventSent: { alignSelf: 'flex-end' },
  eventSystem: { alignSelf: 'center', maxWidth: '100%' },
  eventCompact: { maxWidth: '94%', marginBottom: 2 },
  eventBubble: { borderWidth: 3, borderColor: '#171717', borderRadius: 8, backgroundColor: '#FFFFFF', padding: 12, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  eventBubbleAi: { backgroundColor: '#D9C8FF' },
  eventBubbleEscalation: { backgroundColor: '#F4C7A1' },
  eventBubbleError: { backgroundColor: '#F7B6AB' },
  eventBubbleWarn: { backgroundColor: '#F4C7A1' },
  eventHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  eventType: { fontWeight: '900', color: '#FFFFFF', backgroundColor: '#171717', borderWidth: 2, borderColor: '#171717', borderRadius: 4, paddingHorizontal: 7, paddingVertical: 3, overflow: 'hidden', fontSize: 9 },
  eventTagVision: { backgroundColor: '#D4EEF5', color: '#171717' },
  eventTagOcr: { backgroundColor: '#E0D4F5', color: '#171717' },
  eventTagAi: { backgroundColor: '#7B4BFF', color: '#FFFFFF' },
  eventTagOpenClaw: { backgroundColor: '#C9F2D1', color: '#171717' },
  eventTime: { color: '#7B715F', fontWeight: '800', fontSize: 10 },
  eventBody: { color: '#342F28', lineHeight: 19, fontWeight: '700', fontSize: 13 },
  logsPage: { flex: 1, minHeight: 0, padding: 14 },
  logsList: { flex: 1, minHeight: 0 },
  logsListContent: { paddingBottom: 12, flexGrow: 1 },
  filterScroll: { maxHeight: 46, marginBottom: 10 },
  filterButton: { borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#FFFFFF', paddingHorizontal: 14, paddingVertical: 9, marginRight: 8 },
  filterActive: { backgroundColor: '#171717' },
  filterText: { color: '#5F5747', fontWeight: '900' },
  filterTextActive: { color: '#F7D748' },
  empty: { color: '#7B715F', padding: 20, textAlign: 'center' },
  label: { color: '#171717', fontWeight: '900', marginTop: 10 },
  input: { borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#FFFFFF', minHeight: 48, paddingHorizontal: 12, color: '#171717', fontWeight: '700' },
  connectionCard: { borderWidth: 3, borderColor: '#171717', borderRadius: 8, backgroundColor: '#FFFFFF', padding: 14, marginTop: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  connectionTitle: { fontWeight: '900', fontSize: 16, color: '#171717' },
  connectionCopy: { color: '#6B6255', marginTop: 8, lineHeight: 20 },
  dangerButton: { borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#F7B6AB', padding: 12, alignItems: 'center', marginTop: 12 },
  dangerText: { fontWeight: '900', color: '#171717' },
  tabs: { height: 66, flexDirection: 'row', borderTopWidth: 2, borderColor: '#171717', backgroundColor: '#FFFFFF' },
  tabButton: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: '#F7D748' },
  tabText: { color: '#7B715F', fontWeight: '900' },
  tabTextActive: { color: '#171717' },
});
