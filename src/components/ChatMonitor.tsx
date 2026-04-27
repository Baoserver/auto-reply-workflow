import React, { useEffect, useRef, useState } from 'react';

interface AgentEvent {
  type: string;
  data: any;
}

interface Props {
  events: AgentEvent[];
}

export default function ChatMonitor({ events }: Props) {
  const [tracking, setTracking] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tracking || !containerRef.current) return;
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      containerRef.current.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, [events.length, tracking]);

  const followButton = (
    <button
      className={`log-follow-btn ${tracking ? 'active' : ''}`}
      onClick={() => setTracking((value) => !value)}
    >
      跟踪 {tracking ? 'ON' : 'OFF'}
    </button>
  );

  if (events.length === 0) {
    return (
      <div className="log-panel">
        <div className="log-empty">
          <div className="log-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
          </div>
          <div className="log-empty-text">暂无日志</div>
          <div className="log-empty-hint">启动监控后，实时日志将在此显示</div>
        </div>
        {followButton}
      </div>
    );
  }

  return (
    <div className="log-panel">
      <div className="log-container" ref={containerRef}>
        <div className="log-timeline">
          {events.map((ev, i) => {
          const time = new Date();
          const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;

          if (ev.type === 'message') {
            const isWechat = ev.data.channel === '微信';
            return (
              <div key={i} className="log-item received">
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
              <div key={i} className="log-item sent">
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
              <div key={i} className="log-item system">
                <div className="log-system-badge">
                  <span className="log-status-icon">●</span>
                  <span>{ev.data.state === 'running' ? '服务已启动' : '服务已停止'}</span>
                </div>
              </div>
            );
          }

          if (ev.type === 'escalation') {
            return (
              <div key={i} className="log-item escalation">
                <div className="log-escalation-badge">
                  <span>⚠️</span>
                  <span>转人工: {ev.data.reason}</span>
                </div>
              </div>
            );
          }

          if (ev.type === 'log') {
            return (
              <div key={i} className={`log-item log ${ev.data.level === 'error' ? 'error' : 'warn'}`}>
                <div className="log-log-badge">
                  <span>{ev.data.level?.toUpperCase() || 'LOG'}</span>
                  <span>{ev.data.message}</span>
                </div>
              </div>
            );
          }

          if (ev.type === 'ocr') {
            const lines: string[] = ev.data.new_lines || [];
            const windowName = ev.data.window || '';
            return (
              <div key={i} className="log-item ocr">
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
              <div key={i} className="log-item vision">
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
                        {recentMessages.slice(-12).map((item: any, mi: number) => (
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
              <div key={i} className="log-item openclaw">
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
          })}
        </div>
      </div>
      {followButton}
    </div>
  );
}
