"""升级判断模块 — 决定何时转人工"""

from datetime import datetime


class EscalationChecker:
    def __init__(self, config: dict):
        keywords_str = config.get("escalation", {}).get("keywords", "退款,投诉,经理,报警")
        self.keywords = [k.strip() for k in keywords_str.split(",") if k.strip()]
        self.max_rounds = config.get("escalation", {}).get("max_unsolved_rounds", 2)
        self._last_reason = ""

    def should_escalate(self, message: str, conversation_rounds: int) -> bool:
        """判断是否需要升级到人工"""
        # 多轮未解决
        if conversation_rounds > self.max_rounds:
            self.mark_round_limit(conversation_rounds)
            return True

        return False

    def match_keyword(self, message: str) -> str:
        """返回命中的升级关键词；未命中返回空字符串。"""
        for kw in self.keywords:
            if kw and kw in message:
                return kw
        return ""

    def mark_keyword(self, keyword: str):
        self._last_reason = f"关键词触发: {keyword}"

    def mark_round_limit(self, conversation_rounds: int):
        self._last_reason = f"连续{conversation_rounds}轮未解决"

    def set_reason(self, reason: str):
        self._last_reason = reason

    def get_reason(self, message: str = "") -> str:
        """获取上次升级的原因"""
        return self._last_reason or "AI无法确定答案"
