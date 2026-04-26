import React from 'react';

interface AgentEvent {
  type: string;
  data: any;
}

interface Props {
  running: boolean;
  stats: { messages: number; autoReplies: number; escalations: number };
  connections?: { wechat: boolean; wecom: boolean };
  events?: AgentEvent[];
}

export default function Dashboard({ running, stats, connections, events = [] }: Props) {
  const replyRate = stats.messages > 0
    ? ((stats.autoReplies / stats.messages) * 100).toFixed(1)
    : '0';

  const wechatConnected = connections?.wechat ?? false;
  const wecomConnected = connections?.wecom ?? false;

  // 过滤出消息和回复
  const messages = events.filter(e => e.type === 'message');
  const replies = events.filter(e => e.type === 'reply');

  return (
    <div className="dashboard">
      {/* Top Cards Row */}
      <div className="top-cards-row">
        {/* Connection Card - Left */}
        <div className="card connection-card">
          <div className="card-label">设备连接</div>
          <div className="connection-list">
            <div className="connection-item">
              <div className="connection-icon wechat-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
                </svg>
              </div>
              <span className="connection-name">微信</span>
              <span className={`status-badge ${wechatConnected ? 'online' : 'offline'}`}>
                {wechatConnected ? '已连接' : '未连接'}
              </span>
            </div>
            <div className="connection-item">
              <div className="connection-icon wecom-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
                </svg>
              </div>
              <span className="connection-name">企业微信</span>
              <span className={`status-badge ${wecomConnected ? 'online' : 'offline'}`}>
                {wecomConnected ? '已连接' : '未连接'}
              </span>
            </div>
          </div>
        </div>

        {/* Stats Card - Right */}
        <div className="card stats-card">
          <div className="card-label">今日数据</div>
          <div className="stats-row">
            <div className="stat-item">
              <span className="stat-value" style={{ color: '#007AFF' }}>{stats.messages}</span>
              <span className="stat-label">回复次数</span>
            </div>
            <div className="stat-item">
              <span className="stat-value" style={{ color: '#34C759' }}>{replyRate}%</span>
              <span className="stat-label">自动回复率</span>
            </div>
            <div className="stat-item">
              <span className="stat-value" style={{ color: stats.escalations > 0 ? '#FF9500' : '#A1A1A6' }}>{stats.escalations}</span>
              <span className="stat-label">转人工</span>
            </div>
          </div>
        </div>
      </div>

      {/* Chat Card */}
      <div className="card chat-card">
        <div className="chat-container">
          {/* Left - Channel Messages */}
          <div className="chat-left">
            <div className="chat-section-title">渠道消息</div>
            {messages.length === 0 ? (
              <div className="chat-empty">暂无消息</div>
            ) : (
              messages.slice(-5).map((msg, i) => (
                <div key={i} className="chat-bubble received">
                  <span className={`bubble-source ${msg.data.channel === '企业微信' ? 'wecom' : 'wechat'}`}>
                    {msg.data.channel === '企业微信' ? '企微' : '微信'}
                  </span>
                  <span className="bubble-text">{msg.data.content}</span>
                </div>
              ))
            )}
          </div>

          {/* Right - AI Replies */}
          <div className="chat-right">
            <div className="chat-section-title">AI 处理</div>
            {replies.length === 0 ? (
              <div className="chat-empty">暂无回复</div>
            ) : (
              replies.slice(-5).map((reply, i) => (
                <div key={i} className="chat-bubble sent">
                  <span className="bubble-text">{reply.data.content}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Info Card */}
      <div className="card info-card">
        <div className="info-row-inner">
          <div className="info-item">
            <span className="info-label">连接</span>
            <span className={`info-value ${running ? 'online' : ''}`}>{running ? '正常' : '断开'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">消息</span>
            <span className="info-value">{messages.length}</span>
          </div>
          <div className="info-item">
            <span className="info-label">回复</span>
            <span className="info-value">{replies.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
