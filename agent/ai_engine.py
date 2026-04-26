"""AI 回复引擎 — MiniMax 文本模型 + 知识库 RAG"""

import httpx


SYSTEM_PROMPT = """你是专业的客服助手。基于提供的知识库内容回答客户问题。

规则：
1. 只回答你确定知道的问题
2. 回复要简洁专业，控制在150字以内
3. 使用简体中文
4. 不要提及AI、模型、程序等技术细节"""


class AIEngine:
    def __init__(self, config: dict):
        self.api_key = config.get("minimax", {}).get("api_key", "")
        self.group_id = config.get("minimax", {}).get("group_id", "")
        self.model = config.get("minimax", {}).get("text_model", "MiniMax-Text-01")
        self.base_url = "https://api.minimax.chat/v1/chat/completions"
        self.knowledge_context = ""
        self._load_knowledge()

    def _load_knowledge(self):
        """加载知识库文件"""
        from pathlib import Path
        kb_dir = Path(__file__).parent.parent / "knowledge"
        if not kb_dir.exists():
            return
        texts = []
        for f in sorted(kb_dir.glob("*.md")):
            texts.append(f"## {f.stem}\n{f.read_text(encoding='utf-8')}")
        for f in sorted(kb_dir.glob("*.txt")):
            texts.append(f"## {f.stem}\n{f.read_text(encoding='utf-8')}")
        self.knowledge_context = "\n\n".join(texts)

    def generate_reply(self, message: str, channel: str = "微信") -> str | None:
        """
        生成回复。返回 None 表示需要升级到人工。
        """
        knowledge_section = ""
        if self.knowledge_context:
            knowledge_section = f"\n\n知识库内容：\n{self.knowledge_context}"

        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT + knowledge_section},
                {"role": "user", "content": f"客户通过{channel}发来消息：{message}"},
            ],
            "temperature": 0.3,
            "max_tokens": 300,
        }
        if self.group_id:
            payload["group_id"] = self.group_id

        try:
            resp = httpx.post(self.base_url, headers=headers, json=payload, timeout=20)
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            return content if content else None
        except Exception as e:
            print(f"AI Engine error: {e}")
            return None
