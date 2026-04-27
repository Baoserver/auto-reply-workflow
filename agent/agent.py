"""视觉智能客服 Agent 主入口 — 被 Electron 调起"""

import json
import sys
import time
import threading
import signal
from pathlib import Path
import pyautogui

sys.path.insert(0, str(Path(__file__).parent))

from screen_capture import ScreenCapture
from vision import VisionAnalyzer
from ai_engine import AIEngine
from wechat_operator import WeChatOperator
from wechat_detector import WeChatDetector
from escalation import EscalationChecker
from feishu_bot import FeishuBot

CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"
import yaml


def load_config():
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH) as f:
            return yaml.safe_load(f) or {}
    return {}


def emit(event_type: str, data: dict):
    """向 stdout 输出 JSON Lines 事件，Electron 会读取"""
    print(json.dumps({"type": event_type, "data": data}, ensure_ascii=False), flush=True)


class Agent:
    def __init__(self):
        self.config = load_config()
        self.running = False
        self.capture = ScreenCapture()
        self.operator = WeChatOperator()
        self.conversation_rounds = {}
        self._build_runtime()

    def _build_runtime(self):
        self.vision = VisionAnalyzer(self.config)
        self.ai = AIEngine(self.config)
        self.detector = WeChatDetector(self.capture, self.vision, self.config)
        self.escalation = EscalationChecker(self.config)
        self.feishu = FeishuBot(self.config)

    def start(self):
        if self.running:
            return
        self.running = True
        emit("status", {"state": "running"})
        self.detector.start(self._on_new_message, self._on_assistant_workflow)

    def stop(self):
        print("[Agent] stop() called", flush=True)
        self.running = False
        self.detector.stop()
        emit("status", {"state": "stopped"})

    def reload_config(self):
        was_running = self.running
        if was_running:
            self.detector.stop()

        self.config = load_config()
        self._build_runtime()

        if was_running:
            self.detector.start(self._on_new_message, self._on_assistant_workflow)
            emit("status", {"state": "running"})

        interval = self.config.get("ocr", {}).get("check_interval", 3)
        emit("log", {"level": "info", "message": f"配置已重新加载，检测间隔 {interval}s"})

    def _on_new_message(self, channel: str, sender: str, content: str, screenshot_path: str = "", vision_result: dict = None):
        if not self.running:
            return

        emit("message", {"channel": channel, "sender": sender, "content": content})

        # 更新输入框坐标
        if vision_result and vision_result.get("input_box"):
            try:
                x_ratio, y_ratio = vision_result["input_box"]
                screen_size = pyautogui.size()
                x = int(x_ratio * screen_size[0])
                y = int(y_ratio * screen_size[1])
                self.operator.update_input_box_position(x, y)
            except Exception:
                pass

        rounds = self.conversation_rounds.get(sender, 0) + 1
        self.conversation_rounds[sender] = rounds

        if self.escalation.should_escalate(content, rounds):
            self._escalate(channel, sender, content)
            return

        try:
            context = self._format_conversation_context(vision_result)
            reply = self.ai.generate_reply(content, channel=channel, sender=sender, context=context)
        except Exception as e:
            print(f"[Agent] AI error: {e}", flush=True)
            reply = None
        if reply is None:
            reply = "您好，请问有什么可以帮助您的？"

        emit("reply", {"content": reply})

        mode = self.config.get("mode", "auto")
        if mode == "auto":
            delay_min = self.config.get("reply_delay_min", 1)
            delay_max = self.config.get("reply_delay_max", 3)
            import random
            time.sleep(random.uniform(delay_min, delay_max))
            try:
                self.operator.type_and_send(reply, window_name=channel)
            except Exception as e:
                print(f"[Agent] send error: {e}", flush=True)

    def _escalate(self, channel: str, sender: str, content: str):
        reason = self.escalation.get_reason(content)
        notified = False
        if self.feishu.is_configured():
            notified = self.feishu.send_notification(
                channel=channel, sender=sender, content=content, reason=reason
            )
        emit("escalation", {"reason": reason, "feishu_notified": notified})
        self.operator.type_and_send("好的，我帮您转接人工客服，请稍候~", window_name=channel)
        self.conversation_rounds.pop(sender, None)

    def _on_assistant_workflow(self, channel: str, route, trigger_text: str, screenshot_path: str = "", vision_result: dict = None) -> bool:
        if not self.running:
            return False

        context = self._format_conversation_context(vision_result)
        emit("message", {
            "channel": channel,
            "sender": f"助手模式/{route.agent_name or route.agent_id}",
            "content": trigger_text,
        })

        if vision_result and vision_result.get("input_box"):
            try:
                x_ratio, y_ratio = vision_result["input_box"]
                screen_size = pyautogui.size()
                x = int(x_ratio * screen_size[0])
                y = int(y_ratio * screen_size[1])
                self.operator.update_input_box_position(x, y)
            except Exception:
                pass

        try:
            openclaw_result = self.ai.openclaw.run_agent_detail(
                route=route,
                message=trigger_text,
                channel=channel,
                sender="助手模式",
                context=context,
            )
            reply = openclaw_result.get("reply") if openclaw_result else None
        except Exception as e:
            print(f"[Agent] OpenClaw assistant error: {e}", flush=True)
            reply = None

        if not reply:
            emit("log", {
                "level": "warn",
                "message": f"助手模式 OpenClaw 未返回可发送内容，agent={route.agent_id}",
            })
            return False

        emit("reply", {"content": reply, "workflow_mode": "assistant"})

        try:
            self.operator.type_and_send(reply, window_name=channel)
            emit("log", {
                "level": "info",
                "message": f"助手模式已自动发送 OpenClaw 回复，agent={route.agent_id}",
            })
            return True
        except Exception as e:
            print(f"[Agent] assistant send error: {e}", flush=True)
            emit("log", {"level": "error", "message": f"助手模式发送失败: {e}"})
            return False

    def _format_conversation_context(self, vision_result: dict | None) -> str:
        if not vision_result:
            return ""

        conversation_text = str(vision_result.get("conversation_text") or "").strip()
        visible_text = str(vision_result.get("visible_text") or "").strip()
        recent_messages = vision_result.get("recent_messages")
        if isinstance(recent_messages, list) and recent_messages:
            lines = []
            for item in recent_messages[-20:]:
                if not isinstance(item, dict):
                    continue
                speaker = str(item.get("sender") or ("我方" if item.get("is_self") else "客户")).strip()
                message = str(item.get("content") or "").strip()
                if message:
                    lines.append(f"{speaker}: {message}")
            if lines:
                context = "\n".join(lines)
                if conversation_text and conversation_text not in context:
                    context = f"{conversation_text}\n\n结构化消息：\n{context}"
                if visible_text and visible_text not in context:
                    context = f"{context}\n\n可见文字：\n{visible_text}"
                return context[-5000:]

        if conversation_text and visible_text and visible_text not in conversation_text:
            return f"{conversation_text}\n\n可见文字：\n{visible_text}"[-5000:]
        return (conversation_text or visible_text)[-5000:]


def main():
    agent = Agent()

    def read_commands():
        for line in sys.stdin:
            try:
                cmd = json.loads(line.strip())
                action = cmd.get("action")
                if action == "start":
                    agent.start()
                elif action == "stop":
                    agent.stop()
                elif action == "reload_config":
                    agent.reload_config()
            except (json.JSONDecodeError, KeyError):
                pass

    cmd_thread = threading.Thread(target=read_commands, daemon=True)
    cmd_thread.start()

    agent.start()

    signal.signal(signal.SIGINT, lambda *_: (agent.stop(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (agent.stop(), sys.exit(0)))

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        agent.stop()
    except Exception as e:
        print(f"[Agent] Fatal error: {e}", flush=True)
        agent.stop()


if __name__ == "__main__":
    main()
