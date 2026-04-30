import React, { useState, useEffect } from 'react';

interface OpenClawRoute {
  enabled: boolean;
  keywords: string;
  agent_id: string;
  agent_name: string;
  extra_prompt: string;
}

interface OpenClawAgent {
  id: string;
  name: string;
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

function flattenConfig(loaded: any): Config {
  return {
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
    ocr_chat_region_mode: loaded.ocr?.chat_region_mode || 'auto',
    ocr_chat_region: Array.isArray(loaded.ocr?.chat_region) ? loaded.ocr.chat_region : [0.35, 0, 1, 1],
    ocr_trigger_keywords: loaded.ocr?.trigger_keywords || DEFAULT_CONFIG.ocr_trigger_keywords,
    openclaw_customer: normalizeOpenClawConfig(loaded.openclaw, 'customer'),
    openclaw_assistant: normalizeOpenClawConfig(loaded.openclaw, 'assistant'),
  };
}

export default function WorkflowPanel() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [openClawAgents, setOpenClawAgents] = useState<OpenClawAgent[]>([]);

  useEffect(() => {
    const loadAgents = async (cliPath = DEFAULT_OPENCLAW_CONFIG.cli_path) => {
      if (!window.electronAPI?.listOpenClawAgents) return;
      setAgentsLoading(true);
      try {
        const agents = await window.electronAPI.listOpenClawAgents(cliPath);
        setOpenClawAgents(agents || []);
      } catch (e) {
        console.error('Failed to load OpenClaw agents:', e);
        setOpenClawAgents([]);
      } finally {
        setAgentsLoading(false);
      }
    };

    const loadConfig = async () => {
      if (!window.electronAPI) {
        const stored = localStorage.getItem('vision-cs-config');
        if (stored) {
          try {
            setConfig({ ...DEFAULT_CONFIG, ...JSON.parse(stored) });
          } catch {}
        }
        setLoading(false);
        return;
      }

      try {
        const loaded = await window.electronAPI.loadConfig();
        if (loaded && Object.keys(loaded).length > 0) {
          const flattened = flattenConfig(loaded);
          setConfig(flattened);
          const activeOpenClaw = flattened.workflow_mode === 'assistant'
            ? flattened.openclaw_assistant
            : flattened.openclaw_customer;
          loadAgents(activeOpenClaw.cli_path);
        } else {
          loadAgents();
        }
      } catch (e) {
        console.error('Failed to load workflow config:', e);
        loadAgents();
      }
      setLoading(false);
    };

    loadConfig();
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

  const activeOpenClawKey = config.workflow_mode === 'assistant' ? 'openclaw_assistant' : 'openclaw_customer';
  const activeOpenClaw = config[activeOpenClawKey];
  const openClawModeLabel = config.workflow_mode === 'assistant' ? '助手模式' : '客服模式';
  const openClawEmptyText = config.workflow_mode === 'assistant'
    ? '暂无路由规则，助手模式不会触发 OpenClaw。'
    : '暂无路由规则，未命中时会回退 MiniMax。';

  const updateActiveOpenClaw = (patch: Partial<OpenClawConfig>) => {
    setConfig((prev) => ({
      ...prev,
      [activeOpenClawKey]: {
        ...prev[activeOpenClawKey],
        ...patch,
      },
    }));
  };

  const addOpenClawRoute = () => {
    const firstAgent = openClawAgents[0];
    setConfig((prev) => ({
      ...prev,
      [activeOpenClawKey]: {
        ...prev[activeOpenClawKey],
        routes: [
          ...prev[activeOpenClawKey].routes,
          {
            enabled: true,
            keywords: '',
            agent_id: firstAgent?.id || '',
            agent_name: firstAgent?.name || '',
            extra_prompt: '',
          },
        ],
      },
    }));
  };

  const updateOpenClawRoute = (index: number, patch: Partial<OpenClawRoute>) => {
    setConfig((prev) => ({
      ...prev,
      [activeOpenClawKey]: {
        ...prev[activeOpenClawKey],
        routes: prev[activeOpenClawKey].routes.map((route, i) => (
          i === index ? { ...route, ...patch } : route
        )),
      },
    }));
  };

  const removeOpenClawRoute = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      [activeOpenClawKey]: {
        ...prev[activeOpenClawKey],
        routes: prev[activeOpenClawKey].routes.filter((_, i) => i !== index),
      },
    }));
  };

  const selectOpenClawAgent = (index: number, agentId: string) => {
    const agent = openClawAgents.find((item) => item.id === agentId);
    updateOpenClawRoute(index, {
      agent_id: agentId,
      agent_name: agent?.name || '',
    });
  };

  const refreshOpenClawAgents = async () => {
    if (!window.electronAPI?.listOpenClawAgents) return;
    setAgentsLoading(true);
    try {
      const agents = await window.electronAPI.listOpenClawAgents(activeOpenClaw.cli_path);
      setOpenClawAgents(agents || []);
    } catch (e) {
      console.error('Failed to refresh OpenClaw agents:', e);
      setOpenClawAgents([]);
    } finally {
      setAgentsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="card">
        <div className="card-title">加载中...</div>
      </div>
    );
  }

  return (
    <div className="panel-stack workflow-stack">
      <div className="card">
        <div className="card-header">
          <span className="card-title">回复策略</span>
        </div>

        <div className="form-group">
          <label>监控渠道</label>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={config.wechat_enabled}
                onChange={(e) => update('wechat_enabled', e.target.checked)} />
              微信
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={config.wecom_enabled}
                onChange={(e) => update('wecom_enabled', e.target.checked)} />
              企业微信
            </label>
          </div>
        </div>

        <div className="form-group">
          <label>工作模式</label>
          <select value={config.workflow_mode} onChange={(e) => update('workflow_mode', e.target.value)}>
            <option value="customer">客服模式 — 识别客户新消息并回复</option>
            <option value="assistant">助手模式 — 关键词触发完整上下文工作流</option>
          </select>
        </div>

        <div className="form-group">
          <label>回复模式</label>
          <select value={config.mode} onChange={(e) => update('mode', e.target.value)}>
            <option value="assist">辅助模式 — AI 生成建议，人工确认发送</option>
            <option value="auto">托管模式 — AI 自动回复</option>
          </select>
        </div>

        {config.workflow_mode === 'customer' && (
          <>
            <div className="form-group">
              <label>升级关键词（逗号分隔）</label>
              <input value={config.escalation_keywords}
                onChange={(e) => update('escalation_keywords', e.target.value)}
                placeholder="退款,投诉,经理,报警" />
            </div>
            <div className="form-group">
              <label>未解决轮数上限</label>
              <input type="number" value={config.max_unsolved_rounds} min={1} max={10}
                onChange={(e) => update('max_unsolved_rounds', parseInt(e.target.value) || 2)} />
            </div>
          </>
        )}

        {config.workflow_mode === 'customer' && <div className="form-row">
          <div className="form-group">
            <label>延迟下限（秒）</label>
            <input type="number" value={config.reply_delay_min} min={0} max={10}
              onChange={(e) => update('reply_delay_min', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="form-group">
            <label>延迟上限（秒）</label>
            <input type="number" value={config.reply_delay_max} min={1} max={15}
              onChange={(e) => update('reply_delay_max', parseFloat(e.target.value) || 3)} />
          </div>
        </div>}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">OpenClaw 工作流（{openClawModeLabel}）</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {agentsLoading ? '读取 Agent 中...' : (openClawAgents.length > 0 ? `${openClawAgents.length} 个 Agent` : '可手动输入 Agent ID')}
          </span>
        </div>
        <div className="form-group">
          <label>启用 OpenClaw 回复</label>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={activeOpenClaw.enabled}
                onChange={(e) => updateActiveOpenClaw({ enabled: e.target.checked })} />
              {activeOpenClaw.enabled ? '已开启' : '已关闭'}
            </label>
          </div>
        </div>
        <div className="form-group">
          <label>CLI 路径</label>
          <input value={activeOpenClaw.cli_path}
            onChange={(e) => updateActiveOpenClaw({ cli_path: e.target.value })}
            placeholder="/opt/homebrew/bin/openclaw" />
          <button className="btn-sm" onClick={refreshOpenClawAgents} style={{ marginTop: 10 }}>
            {agentsLoading ? '刷新中...' : '刷新 Agent 列表'}
          </button>
        </div>
        <div className="form-group">
          <label>超时时间（秒）</label>
          <input type="number" value={activeOpenClaw.timeout_seconds} min={10} max={600}
            onChange={(e) => updateActiveOpenClaw({ timeout_seconds: parseInt(e.target.value) || 120 })} />
        </div>
        <div className="form-group">
          <label>额外提示词</label>
          <textarea value={activeOpenClaw.extra_prompt}
            onChange={(e) => updateActiveOpenClaw({ extra_prompt: e.target.value })}
            placeholder="例如：回复需简洁、语气友好，遇到价格争议提醒人工确认。" />
        </div>
        <div className="form-group">
          <label>关键词路由</label>
          {activeOpenClaw.routes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
              {openClawEmptyText}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeOpenClaw.routes.map((route, index) => (
                <div key={index} style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 10,
                  background: 'var(--bg-secondary)',
                }}>
                  <div className="checkbox-group" style={{ marginBottom: 8 }}>
                    <label className="checkbox-label">
                      <input type="checkbox" checked={route.enabled}
                        onChange={(e) => updateOpenClawRoute(index, { enabled: e.target.checked })} />
                      规则 {index + 1} {route.enabled ? '启用' : '停用'}
                    </label>
                    <button className="btn-sm danger" onClick={() => removeOpenClawRoute(index)}>删除</button>
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>关键词（逗号分隔）</label>
                    <input value={route.keywords}
                      onChange={(e) => updateOpenClawRoute(index, { keywords: e.target.value })}
                      placeholder="退款,发票,招聘" />
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>选择 OpenClaw Agent</label>
                    {openClawAgents.length > 0 ? (
                      <div className="agent-choice-list">
                        {openClawAgents.map((agent) => {
                          const active = route.agent_id === agent.id;
                          return (
                            <button
                              key={agent.id}
                              type="button"
                              className={`agent-choice ${active ? 'active' : ''}`}
                              onClick={() => selectOpenClawAgent(index, agent.id)}
                            >
                              <span>{agent.name || agent.id}</span>
                              <small>{agent.id}</small>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                        未读取到 Agent，可刷新列表或手动输入 Agent ID。
                      </div>
                    )}
                  </div>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label>Agent ID</label>
                    <input value={route.agent_id}
                      onChange={(e) => updateOpenClawRoute(index, { agent_id: e.target.value, agent_name: '' })}
                      placeholder="例如 qinwu-yuan" />
                    {route.agent_name && (
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                        {route.agent_name}
                      </div>
                    )}
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>额外提示词</label>
                    <textarea value={route.extra_prompt}
                      onChange={(e) => updateOpenClawRoute(index, { extra_prompt: e.target.value })}
                      placeholder="此路由专属提示词，例如：回复需简洁、遇到价格争议提醒人工确认。" />
                  </div>
                </div>
              ))}
            </div>
          )}
          <button className="btn-sm" onClick={addOpenClawRoute} style={{ marginTop: 10 }}>新增路由</button>
        </div>
      </div>

      <button className={`btn-primary ${saved ? 'saved' : ''}`} onClick={save} style={{ width: '100%' }}>
        {saved ? (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8l4 4 8-8"/></svg>
            已保存
          </>
        ) : '保存工作流'}
      </button>
    </div>
  );
}
