import React, { useState, useEffect } from 'react';

interface OpenClawRoute {
  enabled: boolean;
  keywords: string;
  agent_id: string;
  agent_name: string;
  extra_prompt: string;
}

interface OpenClawConfig {
  enabled: boolean;
  cli_path: string;
  timeout_seconds: number;
  extra_prompt: string;
  routes: OpenClawRoute[];
}

interface Config {
  minimax_api_key: string;
  minimax_group_id: string;
  minimax_vision_model: string;
  minimax_text_model: string;
  feishu_webhook_url: string;
  wechat_enabled: boolean;
  wecom_enabled: boolean;
  workflow_mode: 'customer' | 'assistant';
  mode: 'assist' | 'auto';
  escalation_keywords: string;
  max_unsolved_rounds: number;
  reply_delay_min: number;
  reply_delay_max: number;
  ocr_enabled: boolean;
  ocr_fast_mode: boolean;
  ocr_check_interval: number;
  ocr_guard_enabled: boolean;
  ocr_guard_previous_check_interval: number;
  ocr_chat_region_mode: 'auto' | 'fixed';
  ocr_chat_region: number[];
  ocr_trigger_keywords: string;
  openclaw_customer: OpenClawConfig;
  openclaw_assistant: OpenClawConfig;
}

const DEFAULT_OPENCLAW_CONFIG: OpenClawConfig = {
  enabled: false,
  cli_path: '/opt/homebrew/bin/openclaw',
  timeout_seconds: 120,
  extra_prompt: '',
  routes: [],
};

const DEFAULT_CONFIG: Config = {
  minimax_api_key: '',
  minimax_group_id: '',
  minimax_vision_model: 'MiniMax-VL-01',
  minimax_text_model: 'MiniMax-Text-01',
  feishu_webhook_url: '',
  wechat_enabled: true,
  wecom_enabled: true,
  workflow_mode: 'customer',
  mode: 'auto',
  escalation_keywords: '退款,投诉,经理,报警',
  max_unsolved_rounds: 2,
  reply_delay_min: 1,
  reply_delay_max: 3,
  ocr_enabled: true,
  ocr_fast_mode: true,
  ocr_check_interval: 3,
  ocr_guard_enabled: false,
  ocr_guard_previous_check_interval: 3,
  ocr_chat_region_mode: 'auto',
  ocr_chat_region: [0.35, 0, 1, 1],
  ocr_trigger_keywords: '怎么,如何,能不能,请问,价格,发货,退款,投诉,订单,物流,客服,帮助,问题',
  openclaw_customer: { ...DEFAULT_OPENCLAW_CONFIG },
  openclaw_assistant: { ...DEFAULT_OPENCLAW_CONFIG },
};

function normalizeOpenClawRoutes(routes: any): OpenClawRoute[] {
  return Array.isArray(routes)
    ? routes.map((route: any) => ({
      enabled: route.enabled ?? true,
      keywords: Array.isArray(route.keywords) ? route.keywords.join(',') : (route.keywords || ''),
      agent_id: route.agent_id || '',
      agent_name: route.agent_name || '',
      extra_prompt: route.extra_prompt || '',
    }))
    : [];
}

function normalizeOpenClawConfig(openclaw: any, mode: 'customer' | 'assistant'): OpenClawConfig {
  const isNested = openclaw?.customer || openclaw?.assistant;
  const cfg = isNested ? (openclaw?.[mode] || {}) : (openclaw || {});
  return {
    enabled: cfg.enabled ?? DEFAULT_OPENCLAW_CONFIG.enabled,
    cli_path: cfg.cli_path || DEFAULT_OPENCLAW_CONFIG.cli_path,
    timeout_seconds: cfg.timeout_seconds || DEFAULT_OPENCLAW_CONFIG.timeout_seconds,
    extra_prompt: cfg.extra_prompt || '',
    routes: normalizeOpenClawRoutes(cfg.routes),
  };
}

export default function ConfigPanel() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mobileInfo, setMobileInfo] = useState<{ running: boolean; port: number | null }>({ running: false, port: null });
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);

  useEffect(() => {
    const loadConfig = async () => {
      if (!window.electronAPI) {
        const stored = localStorage.getItem('vision-cs-config');
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            setConfig({ ...DEFAULT_CONFIG, ...parsed });
          } catch {}
        }
        setLoading(false);
        return;
      }

      try {
        const loaded = await window.electronAPI.loadConfig();
        if (loaded && Object.keys(loaded).length > 0) {
          setConfig({
            minimax_api_key: loaded.minimax?.api_key || '',
            minimax_group_id: loaded.minimax?.group_id || '',
            minimax_vision_model: loaded.minimax?.vision_model || 'MiniMax-VL-01',
            minimax_text_model: loaded.minimax?.text_model || 'MiniMax-Text-01',
            feishu_webhook_url: loaded.feishu?.webhook_url || '',
            wechat_enabled: loaded.wechat?.enabled ?? true,
            wecom_enabled: loaded.wecom?.enabled ?? true,
            workflow_mode: loaded.workflow_mode || 'customer',
            mode: loaded.mode || 'auto',
            escalation_keywords: loaded.escalation?.keywords || '退款,投诉,经理,报警',
            max_unsolved_rounds: loaded.escalation?.max_unsolved_rounds || 2,
            reply_delay_min: loaded.reply_delay_min || 1,
            reply_delay_max: loaded.reply_delay_max || 3,
            ocr_enabled: loaded.ocr?.enabled ?? true,
            ocr_fast_mode: loaded.ocr?.fast_mode ?? true,
            ocr_check_interval: loaded.ocr?.check_interval || 3,
            ocr_guard_enabled: loaded.ocr?.guard_enabled ?? false,
            ocr_guard_previous_check_interval: loaded.ocr?.guard_previous_check_interval || 3,
            ocr_chat_region_mode: loaded.ocr?.chat_region_mode || 'auto',
            ocr_chat_region: Array.isArray(loaded.ocr?.chat_region) ? loaded.ocr.chat_region : [0.35, 0, 1, 1],
            ocr_trigger_keywords: loaded.ocr?.trigger_keywords || DEFAULT_CONFIG.ocr_trigger_keywords,
            openclaw_customer: normalizeOpenClawConfig(loaded.openclaw, 'customer'),
            openclaw_assistant: normalizeOpenClawConfig(loaded.openclaw, 'assistant'),
          });
        }
      } catch (e) {
        console.error('Failed to load config:', e);
      }
      setLoading(false);
    };

    loadConfig();
  }, []);

  useEffect(() => {
    const loadMobileInfo = async () => {
      if (!window.electronAPI?.getMobileServiceInfo) return;
      try {
        const info = await window.electronAPI.getMobileServiceInfo();
        setMobileInfo(info || { running: false, port: null });
      } catch {}
    };

    loadMobileInfo();
  }, []);

  const save = async () => {
    if (window.electronAPI) {
      const success = await window.electronAPI.saveConfig(config);
      if (success) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        return;
      }
    }

    localStorage.setItem('vision-cs-config', JSON.stringify(config));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (key: keyof Config, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const startMobilePairing = async () => {
    if (!window.electronAPI?.startMobilePairing) return;
    const pair = await window.electronAPI.startMobilePairing();
    setPairing(pair);
  };

  if (loading) {
    return (
      <div className="card">
        <div className="card-title">加载中...</div>
      </div>
    );
  }

  return (
    <div className="panel-stack config-stack">
      <div className="card">
        <div className="card-header">
          <span className="card-title">手机连接</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {mobileInfo.running ? `端口 ${mobileInfo.port}` : '未启动'}
          </span>
        </div>
        <div className="form-group">
          <label>局域网服务地址</label>
          <input readOnly value={mobileInfo.port ? `http://<本机局域网IP>:${mobileInfo.port}` : '服务启动中...'} />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            手机和 Mac 连接同一 Wi-Fi 后，在 App 连接页填入该地址。
          </div>
        </div>
        {pairing && (
          <div className="form-group">
            <label>配对码</label>
            <input readOnly value={pairing.code} style={{ fontSize: 24, fontWeight: 900, letterSpacing: 4, textAlign: 'center' }} />
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              5 分钟内有效，过期时间 {new Date(pairing.expiresAt).toLocaleTimeString()}
            </div>
          </div>
        )}
        <button className="btn-primary" onClick={startMobilePairing} style={{ width: '100%' }}>
          生成手机配对码
        </button>
      </div>

      {/* Model Config */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">MiniMax 模型</span>
        </div>
        <div className="form-group">
          <label>API Key</label>
          <input type="password" value={config.minimax_api_key}
            onChange={(e) => update('minimax_api_key', e.target.value)}
            placeholder="输入 API Key..." />
        </div>
        <div className="form-group">
          <label>Group ID</label>
          <input value={config.minimax_group_id}
            onChange={(e) => update('minimax_group_id', e.target.value)}
            placeholder="可选" />
        </div>
        <div className="form-group">
          <label>视觉模型</label>
          <select value={config.minimax_vision_model}
            onChange={(e) => update('minimax_vision_model', e.target.value)}>
            <option value="MiniMax-VL-01">MiniMax-VL-01</option>
            <option value="MiniMax-M2.5">MiniMax-M2.5</option>
          </select>
        </div>
        <div className="form-group">
          <label>文本模型</label>
          <select value={config.minimax_text_model}
            onChange={(e) => update('minimax_text_model', e.target.value)}>
            <option value="MiniMax-Text-01">MiniMax-Text-01</option>
            <option value="MiniMax-M2.5">MiniMax-M2.5</option>
          </select>
        </div>
      </div>

      {/* OCR Config */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">本地 OCR 识别</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>macOS Vision</span>
        </div>
        <div className="form-group">
          <label>启用本地 OCR</label>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={config.ocr_enabled}
                onChange={(e) => update('ocr_enabled', e.target.checked)} />
              {config.ocr_enabled ? '已开启' : '已关闭'}
            </label>
          </div>
        </div>
        <div className="form-group">
          <label>识别精度</label>
          <select value={config.ocr_fast_mode ? 'fast' : 'accurate'}
            onChange={(e) => update('ocr_fast_mode', e.target.value === 'fast')}>
            <option value="fast">快速模式 — 延迟低 (~20ms)</option>
            <option value="accurate">精准模式 — 更准确 (~100ms)</option>
          </select>
        </div>
        <div className="form-group">
          <label>检测间隔（秒）</label>
          <input type="number" value={config.ocr_guard_enabled ? 60 : config.ocr_check_interval} min={1} max={config.ocr_guard_enabled ? 60 : 10}
            disabled={config.ocr_guard_enabled}
            onChange={(e) => update('ocr_check_interval', parseInt(e.target.value) || 3)} />
          {config.ocr_guard_enabled && (
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              值守已开启，检测间隔固定为 60 秒
            </div>
          )}
        </div>
        <div className="form-group">
          <label>触发关键词（逗号分隔）</label>
          <input value={config.ocr_trigger_keywords}
            onChange={(e) => update('ocr_trigger_keywords', e.target.value)}
            placeholder="怎么,如何,能不能,请问..." />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            包含这些词的新消息会优先调用视觉API精准分析
          </div>
        </div>
      </div>

      {/* Feishu */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">飞书通知</span>
        </div>
        <div className="form-group">
          <label>Webhook URL</label>
          <input value={config.feishu_webhook_url}
            onChange={(e) => update('feishu_webhook_url', e.target.value)}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
        </div>
      </div>

      <button className={`btn-primary ${saved ? 'saved' : ''}`} onClick={save} style={{ width: '100%' }}>
        {saved ? (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8l4 4 8-8"/></svg>
            已保存
          </>
        ) : '保存配置'}
      </button>
    </div>
  );
}
