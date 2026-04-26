import React from 'react';

interface AgentEvent {
  type: string;
  data: any;
}

interface Props {
  events: AgentEvent[];
}

export default function ChatMonitor({ events }: Props) {
  if (events.length === 0) {
    return (
      <div className="log-empty">
        <div className="log-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </div>
        <div className="log-empty-text">暂无日志</div>
        <div className="log-empty-hint">启动监控后，实时日志将在此显示</div>
      </div>
    );
  }

  return (
    <div className="log-container">
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

          return null;
        })}
      </div>
    </div>
  );
}
