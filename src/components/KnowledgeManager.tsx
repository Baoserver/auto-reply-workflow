import React, { useState, useEffect } from 'react';

interface Doc {
  name: string;
  size: string;
  updatedAt: string;
}

const FileIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 1.5h5L12 4.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"/>
    <path d="M9 1.5v3h3"/>
  </svg>
);

export default function KnowledgeManager() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    setLoading(true);
    if (window.electronAPI) {
      try {
        const files = await window.electronAPI.listKnowledgeFiles();
        setDocs(files || []);
      } catch (e) {
        console.error('Failed to load files:', e);
        setDocs([]);
      }
    } else {
      setDocs([]);
    }
    setLoading(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);

    for (const f of files) {
      const content = await f.text();
      const filename = f.name;

      if (window.electronAPI) {
        await window.electronAPI.writeKnowledgeFile(filename, content);
      }
    }

    await loadFiles();
  };

  const removeDoc = async (name: string) => {
    if (window.electronAPI) {
      await window.electronAPI.deleteKnowledgeFile(name);
    }
    setDocs((prev) => prev.filter((d) => d.name !== name));
  };

  if (loading) {
    return (
      <div className="card">
        <div className="card-title">加载中...</div>
      </div>
    );
  }

  return (
    <div className="panel-stack knowledge-stack">
      <div className="card">
        <div className="card-header">
          <span className="card-title">知识库文档</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{docs.length} 个文件</span>
        </div>
        {docs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div className="empty-state-text">暂无文档</div>
            <div className="empty-state-hint">拖拽文件到下方上传</div>
          </div>
        ) : (
          <div className="knowledge-list">
            {docs.map((doc) => (
              <div className="knowledge-item" key={doc.name}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <div className="file-icon">
                    <FileIcon />
                  </div>
                  <div className="file-info">
                    <div className="filename">{doc.name}</div>
                    <div className="file-meta">{doc.size} / {doc.updatedAt}</div>
                  </div>
                </div>
                <div className="actions">
                  <button className="btn-sm danger" onClick={() => removeDoc(doc.name)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className={`drop-zone ${dragOver ? 'active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="drop-zone-icon">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 4v12M4 10l6-6 6 6"/>
          </svg>
        </div>
        <div className="drop-zone-text">
          {dragOver ? '释放以上传文件' : '拖拽文件到此处上传'}
        </div>
        <div className="drop-zone-hint">支持 TXT / MD 格式</div>
      </div>
    </div>
  );
}
