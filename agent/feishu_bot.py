"""飞书 Bot 通知模块 — 通过 Webhook 推送升级消息"""

import httpx
from datetime import datetime


class FeishuBot:
    def __init__(self, config: dict):
        self.webhook_url = config.get("feishu", {}).get("webhook_url", "")

    def is_configured(self) -> bool:
        return bool(self.webhook_url)

    def send_notification(self, channel: str, sender: str, content: str, reason: str) -> bool:
        """发送飞书通知，返回是否成功"""
        if not self.is_configured():
            return False

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 飞书 Webhook 消息格式
        payload = {
            "msg_type": "interactive",
            "card": {
                "header": {
                    "title": {"tag": "plain_text", "content": "⚠️ 需要人工介入"},
                    "template": "red",
                },
                "elements": [
                    {
                        "tag": "div",
                        "text": {
                            "tag": "lark_md",
                            "content": (
                                f"**来源：** {channel} - {sender}\n"
                                f"**客户消息：** {content}\n"
                                f"**升级原因：** {reason}\n"
                                f"**时间：** {now}"
                            ),
                        },
                    },
                ],
            },
        }

        try:
            resp = httpx.post(self.webhook_url, json=payload, timeout=10)
            return resp.status_code == 200
        except Exception:
            return False
