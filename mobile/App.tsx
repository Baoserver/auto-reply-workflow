import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const appLogo = require('./assets/app-logo.png');

type Tab = 'home' | 'logs' | 'connect';
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

interface DashboardResponse {
  ok: boolean;
  running: boolean;
  connections: { wechat: boolean; wecom: boolean };
  stats: Record<StatsRange, DashboardStats>;
  latestEvents: AgentEvent[];
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
    if (event.type === 'ocr') key = 'visionRecognitions';
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
  const wsRef = useRef<WebSocket | null>(null);

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
    if (Array.isArray(body.latestEvents) && body.latestEvents.length > 0) {
      setEvents((prev) => {
        const seen = new Set(prev.map((event) => event.id || `${event.ts}-${event.type}-${eventBody(event)}`));
        const additions = body.latestEvents.filter((event: AgentEvent) => !seen.has(event.id || `${event.ts}-${event.type}-${eventBody(event)}`));
        return additions.length > 0 ? [...prev, ...additions].slice(-100) : prev;
      });
    }
    setConnected(true);
  }, [authedHeaders, request, serviceUrl, token]);

  const refreshEvents = useCallback(async () => {
    if (!serviceUrl || !token) return;
    const body = await request('/api/events?limit=100', { headers: authedHeaders });
    setEvents(body.events || []);
  }, [authedHeaders, request, serviceUrl, token]);

  const connectStream = useCallback(() => {
    if (!serviceUrl || !token) return;
    wsRef.current?.close();
    const ws = new WebSocket(wsUrlFor(serviceUrl, token));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (message) => {
      try {
        const payload = JSON.parse(String(message.data));
        if (payload.type === 'event' && payload.event) {
          setEvents((prev) => [...prev.slice(-99), payload.event]);
          refreshDashboard().catch(() => {});
        }
      } catch {}
    };
  }, [refreshDashboard, serviceUrl, token]);

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
    refreshDashboard().catch(() => setConnected(false));
    refreshEvents().catch(() => {});
    connectStream();
    const timer = setInterval(() => {
      refreshDashboard().catch(() => setConnected(false));
    }, 10000);
    return () => {
      clearInterval(timer);
      wsRef.current?.close();
    };
  }, [connectStream, refreshDashboard, refreshEvents, serviceUrl, token]);

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

  const localStats = useMemo(() => statsForEvents(events), [events]);
  const visibleStats = mergeStats(dashboard.stats?.[range] || emptyStats, localStats[range]);
  const visibleEvents = events.filter((event) => matchesFilter(event, filter)).slice().reverse();
  const keyEvents = events.filter(isKeyHomeEvent);
  const latestKeyEvents = keyEvents.slice(-6).reverse();

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
        <View style={styles.actionBar}>
          <Pressable style={[styles.actionButton, dashboard.running ? styles.actionStop : styles.actionStart]} onPress={() => controlAgent(dashboard.running ? 'stop' : 'start')} disabled={loading || !token}>
            <Text style={styles.actionButtonText}>{dashboard.running ? '暂停服务' : '开始识别'}</Text>
          </Pressable>
          <Pressable style={[styles.actionButton, styles.actionSecondary]} onPress={() => controlAgent('run-once')} disabled={loading || dashboard.running || !token}>
            <Text style={styles.actionButtonText}>{loading ? '识别中' : '单次识别'}</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.tabs}>
        <TabButton label="首页" active={tab === 'home'} onPress={() => setTab('home')} />
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
  homeStatsCard: { minHeight: 232, flexDirection: 'row', overflow: 'hidden', backgroundColor: '#FFFDF7', borderWidth: 3, borderColor: '#171717', borderRadius: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
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
  actionBar: { flexDirection: 'row', gap: 10, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, borderTopWidth: 2, borderColor: '#171717', backgroundColor: '#FFFDF7' },
  actionButton: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  actionStart: { backgroundColor: '#F7D748' },
  actionStop: { backgroundColor: '#F7B6AB' },
  actionSecondary: { backgroundColor: '#FFFFFF' },
  actionButtonText: { fontWeight: '900', color: '#171717', fontSize: 14 },
  primaryActionWide: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#F7D748', shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  primaryActionText: { fontWeight: '900', color: '#171717' },
  secondaryActionWide: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#171717', borderRadius: 6, backgroundColor: '#FFFFFF', marginBottom: 8, shadowColor: '#171717', shadowOpacity: 1, shadowOffset: { width: 3, height: 3 }, shadowRadius: 0 },
  secondaryActionText: { fontWeight: '900', color: '#171717' },
  sectionTitle: { fontSize: 16, fontWeight: '900', color: '#171717', marginTop: 4 },
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
