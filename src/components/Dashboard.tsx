import React, { useState } from 'react';

interface AgentEvent {
  type: string;
  data: any;
}

interface Props {
  running: boolean;
  stats: {
    day: DashboardStats;
    month: DashboardStats;
    year: DashboardStats;
    total: DashboardStats;
  };
  connections?: { wechat: boolean; wecom: boolean };
  events?: AgentEvent[];
}

type StatsRange = 'day' | 'month' | 'year' | 'total';

interface DashboardStats {
  keywordHits: number;
  visionRecognitions: number;
  aiReplies: number;
  escalations: number;
}

const STAT_TABS: Array<{ key: StatsRange; label: string; hint: string }> = [
  { key: 'day', label: '日', hint: '今日' },
  { key: 'month', label: '月', hint: '本月' },
  { key: 'year', label: '年', hint: '今年' },
  { key: 'total', label: '总', hint: '累计' },
];

export default function Dashboard({ running, stats, connections, events = [] }: Props) {
  const [statsRange, setStatsRange] = useState<StatsRange>('day');
  const wechatConnected = connections?.wechat ?? false;
  const wecomConnected = connections?.wecom ?? false;
  const currentStats = stats[statsRange];

  const isRouteMatchedLog = (ev: AgentEvent) => {
    if (ev.type !== 'log') return false;
    const message = String(ev.data?.message || '');
    if (/OpenClaw assistant route matched/i.test(message)) return false;
    return /助手模式命中路由|OpenClaw route matched|route matched/i.test(message);
  };
  const isKeyHomeLog = (ev: AgentEvent) => (
    ev.type === 'vision' ||
    ev.type === 'reply' ||
    isRouteMatchedLog(ev)
  );
  const keyEvents = events.filter(isKeyHomeLog);
  const latestEvents = keyEvents.slice(-6);

  const renderHomeLog = (ev: AgentEvent, index: number) => {
    const time = new Date();
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;

    if (ev.type === 'message') {
      const isWechat = ev.data.channel === '微信';
      return (
        <div key={index} className="log-item received home-log-item">
          <div className="log-bubble">
            <div className="log-source">
              <span className={`log-tag ${isWechat ? 'wechat' : 'wecom'}`}>
                {isWechat ? '微信' : '企微'}
              </span>
              <span className="log-sender">{ev.data.sender}</span>
            </div>
            <div className="log-text">{ev.data.content}</div>
          </div>
          <div className="log-time">{timeStr}</div>
        </div>
      );
    }

    if (ev.type === 'reply') {
      return (
        <div key={index} className="log-item sent home-log-item">
          <div className="log-bubble ai">
            <div className="log-source">
              <span className="log-tag ai">AI</span>
            </div>
            <div className="log-text">{ev.data.content}</div>
          </div>
          <div className="log-time">{timeStr}</div>
        </div>
      );
    }

    if (ev.type === 'status') {
      return (
        <div key={index} className="log-item system home-log-item">
          <div className="log-system-badge">
            <span className="log-status-icon">●</span>
            <span>{ev.data.state === 'running' ? '服务已启动' : '服务已停止'}</span>
          </div>
        </div>
      );
    }

    if (ev.type === 'escalation') {
      return (
        <div key={index} className="log-item escalation home-log-item">
          <div className="log-escalation-badge">
            <span>转人工: {ev.data.reason}</span>
          </div>
        </div>
      );
    }

    if (ev.type === 'log') {
      return (
        <div key={index} className="log-item openclaw home-log-item">
          <div className="log-log-badge">
            <span>路由</span>
            <span>{ev.data.message}</span>
          </div>
        </div>
      );
    }

    if (ev.type === 'ocr') {
      const lines: string[] = ev.data.new_lines || [];
      const windowName = ev.data.window || '';
      return (
        <div key={index} className="log-item ocr home-log-item">
          <div className="log-ocr-badge">
            <div className="log-ocr-header">
              <span className="log-tag ocr">OCR</span>
              <span className="log-ocr-window">{windowName}</span>
              <span className="log-ocr-count">{lines.length} 行新内容</span>
            </div>
            {lines.length > 0 && (
              <div className="log-ocr-lines">
                {lines.map((line: string, li: number) => (
                  <div key={li} className="log-ocr-line">{line}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (ev.type === 'vision') {
      const r = ev.data.result || {};
      const windowName = ev.data.window || '';
      const msg = r.latest_message || {};
      const recentMessages = Array.isArray(r.recent_messages) ? r.recent_messages : [];
      const conversationText = r.conversation_text || '';
      const visibleText = r.visible_text || '';
      const isAssistantMode = r.workflow_mode === 'assistant';
      return (
        <div key={index} className="log-item vision home-log-item">
          <div className="log-ocr-badge">
            <div className="log-ocr-header">
              <span className="log-tag vision">Vision</span>
              <span className="log-ocr-window">{windowName}</span>
              <span className="log-ocr-count">
                {isAssistantMode ? '完整上下文' : (r.has_new_message ? '新消息' : '无新消息')}
              </span>
            </div>
            <div className="log-ocr-lines">
              {isAssistantMode && r.matched_keyword && (
                <div className="log-ocr-line">命中关键词: {r.matched_keyword}</div>
              )}
              {isAssistantMode && r.route_agent && (
                <div className="log-ocr-line">路由 Agent: {r.route_agent.name || r.route_agent.id}</div>
              )}
              {msg.sender && <div className="log-ocr-line">发送者: {msg.sender}</div>}
              {msg.content && <div className="log-ocr-line">内容: {msg.content}</div>}
              {recentMessages.length > 0 && (
                <>
                  <div className="log-ocr-line log-vision-section">最近对话</div>
                  {recentMessages.slice(-8).map((item: any, mi: number) => (
                    <div key={mi} className="log-ocr-line">
                      {(item.sender || (item.is_self ? '我方' : '客户'))}: {item.content || ''}
                    </div>
                  ))}
                </>
              )}
              {conversationText && (
                <>
                  <div className="log-ocr-line log-vision-section">对话摘要</div>
                  <div className="log-ocr-line">{conversationText}</div>
                </>
              )}
              {visibleText && (
                <>
                  <div className="log-ocr-line log-vision-section">可见文字</div>
                  <div className="log-ocr-line">{visibleText}</div>
                </>
              )}
              {r.input_box && <div className="log-ocr-line">输入框: [{r.input_box.join(', ')}]</div>}
            </div>
          </div>
        </div>
      );
    }

    if (ev.type === 'openclaw') {
      const parsed = ev.data.parsed ? JSON.stringify(ev.data.parsed, null, 2) : '';
      return (
        <div key={index} className="log-item openclaw home-log-item">
          <div className="log-ocr-badge">
            <div className="log-ocr-header">
              <span className="log-tag openclaw">OpenClaw</span>
              <span className="log-ocr-window">{ev.data.agent_name || ev.data.agent_id}</span>
              <span className="log-ocr-count">{ev.data.matched_keyword || '返回'}</span>
            </div>
            <div className="log-ocr-lines">
              {ev.data.reply && (
                <>
                  <div className="log-ocr-line log-vision-section">最终回复</div>
                  <div className="log-ocr-line">{ev.data.reply}</div>
                </>
              )}
              {parsed && (
                <>
                  <div className="log-ocr-line log-vision-section">解析 JSON</div>
                  <pre className="log-json-line">{parsed}</pre>
                </>
              )}
              {ev.data.stdout && (
                <>
                  <div className="log-ocr-line log-vision-section">STDOUT</div>
                  <pre className="log-json-line">{ev.data.stdout}</pre>
                </>
              )}
              {ev.data.stderr && (
                <>
                  <div className="log-ocr-line log-vision-section">STDERR</div>
                  <pre className="log-json-line">{ev.data.stderr}</pre>
                </>
              )}
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="dashboard">
      <section className={`home-hero ${running ? 'is-running' : 'is-paused'}`}>
        <div>
          <div className="home-kicker">AUTO REPLY OPS</div>
          <h1>{running ? '托管运行中' : '等待启动'}</h1>
          <p>{running ? '正在监听窗口变化、OCR 与回复链路。' : '点击底部按钮开始识别微信与企业微信。'}</p>
        </div>
        <div className="home-hero-stamp">
          <span>{running ? 'ON' : 'OFF'}</span>
        </div>
      </section>

      <section className="home-matrix">
        <div className="home-stats-card">
          <div className="home-stats-body">
            <div className="home-stats-tabs" aria-label="统计周期">
              {STAT_TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`home-stats-tab ${statsRange === item.key ? 'active' : ''}`}
                  onClick={() => setStatsRange(item.key)}
                >
                  <span>{item.label}</span>
                  <small>{item.hint}</small>
                </button>
              ))}
            </div>
            <div className="home-stat-grid">
              <div className="home-metric is-keyword">
                <span className="home-metric-label">关键字命中</span>
                <strong>{currentStats.keywordHits}</strong>
                <small>路由触发</small>
              </div>
              <div className="home-metric is-vision">
                <span className="home-metric-label">Vision识别</span>
                <strong>{currentStats.visionRecognitions}</strong>
                <small>视觉分析</small>
              </div>
              <div className="home-metric is-reply">
                <span className="home-metric-label">AI回复</span>
                <strong>{currentStats.aiReplies}</strong>
                <small>已生成</small>
              </div>
              <div className="home-metric is-escalation">
                <span className="home-metric-label">转人工</span>
                <strong>{currentStats.escalations}</strong>
                <small>{currentStats.escalations > 0 ? '需关注' : '暂无'}</small>
              </div>
            </div>
          </div>
        </div>
        <div className="home-channel-card">
          <div className="home-channel-title">设备连接</div>
          <div className="home-channel-row">
            <span>微信</span>
            <b className={wechatConnected ? 'online' : 'offline'}>{wechatConnected ? '已连接' : '未连接'}</b>
          </div>
          <div className="home-channel-row">
            <span>企业微信</span>
            <b className={wecomConnected ? 'online' : 'offline'}>{wecomConnected ? '已连接' : '未连接'}</b>
          </div>
        </div>
      </section>

      <section className="home-message-board">
        <div className="home-board-header">
          <span>关键日志</span>
          <b>{keyEvents.length} 条关键事件</b>
        </div>
        {latestEvents.length === 0 ? (
          <div className="chat-empty">命中路由、Vision 识别和 AI 回复会显示在这里</div>
        ) : (
          <div className="home-log-timeline">
            {latestEvents.map(renderHomeLog)}
          </div>
        )}
      </section>
    </div>
  );
}
