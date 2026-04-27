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
        self.vision = VisionAnalyzer(self.config)
        self.ai = AIEngine(self.config)
        self.operator = WeChatOperator()
        self.detector = WeChatDetector(self.capture, self.vision, self.config)
        self.escalation = EscalationChecker(self.config)
        self.feishu = FeishuBot(self.config)
        self.conversation_rounds = {}

    def start(self):
        self.running = True
        emit("status", {"state": "running"})
        self.detector.start(self._on_new_message)

    def stop(self):
        print("[Agent] stop() called", flush=True)
        self.running = False
        self.detector.stop()
        emit("status", {"state": "stopped"})

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
            reply = self.ai.generate_reply(content, channel=channel, sender=sender)
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
                    agent.config = load_config()
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
