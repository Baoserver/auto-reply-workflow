"""视觉智能客服 Agent 主入口 — 被 Electron 调起"""

import json
import sys
import time
import threading
import signal
import argparse
import uuid
import select
from pathlib import Path
import pyautogui

sys.path.insert(0, str(Path(__file__).parent))

from screen_capture import ScreenCapture
from vision import VisionAnalyzer
from ai_engine import AIEngine
from openclaw_client import OpenClawClient
from openclaw_client import OpenClawRoute
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
        self.pending_replies = {}
        self._build_runtime()

    def _build_runtime(self):
        self.vision = VisionAnalyzer(self.config)
        self.ai = AIEngine(self.config)
        self.assistant_openclaw = OpenClawClient(self.config, mode="assistant")
        self.detector = WeChatDetector(self.capture, self.vision, self.config)
        self.escalation = EscalationChecker(self.config)
        self.feishu = FeishuBot(self.config)

    def start(self):
        if self.running:
            return
        self.running = True
        emit("status", {"state": "running"})
        self.detector.start(self._on_new_message, self._on_assistant_workflow, self._on_customer_escalation)

    def stop(self):
        print("[Agent] stop() called", flush=True)
        self.running = False
        self.detector.stop()
        emit("status", {"state": "stopped"})

    def run_once(self):
        self.running = True
        try:
            self.detector.check_once(self._on_new_message, self._on_assistant_workflow, self._on_customer_escalation)
        finally:
            self.running = False
        if self.pending_replies:
            self.wait_for_pending_replies(timeout_seconds=600)

    def wait_for_pending_replies(self, timeout_seconds: int = 600):
        deadline = time.time() + timeout_seconds
        emit("log", {
            "level": "info",
            "message": f"单次识别存在待确认回复，等待确认或取消，最多 {timeout_seconds}s",
        })
        while self.pending_replies and time.time() < deadline:
            readable, _, _ = select.select([sys.stdin], [], [], 0.5)
            if not readable:
                continue
            line = sys.stdin.readline()
            if not line:
                break
            try:
                cmd = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            action = cmd.get("action")
            if action == "confirm_pending_reply":
                self.confirm_pending_reply(cmd.get("id", ""), cmd.get("content"))
            elif action == "cancel_pending_reply":
                self.cancel_pending_reply(cmd.get("id", ""))
        if self.pending_replies:
            pending_count = len(self.pending_replies)
            self.pending_replies.clear()
            emit("log", {"level": "warn", "message": f"单次识别待确认回复超时，已丢弃 {pending_count} 条"})

    def reload_config(self):
        was_running = self.running
        if was_running:
            self.detector.stop()

        self.config = load_config()
        self._build_runtime()

        if was_running:
            self.detector.start(self._on_new_message, self._on_assistant_workflow, self._on_customer_escalation)
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
            reply = self._generate_customer_reply(content, channel=channel, sender=sender, context=context, vision_result=vision_result)
        except Exception as e:
            print(f"[Agent] AI error: {e}", flush=True)
            reply = None
        if reply is None:
            reply = "您好，请问有什么可以帮助您的？"

        mode = self.config.get("mode", "auto")
        if mode == "auto":
            emit("reply", {"content": reply, "workflow_mode": "customer"})
            delay_min = self.config.get("reply_delay_min", 1)
            delay_max = self.config.get("reply_delay_max", 3)
            import random
            time.sleep(random.uniform(delay_min, delay_max))
            try:
                self.operator.type_and_send(reply, window_name=channel)
            except Exception as e:
                print(f"[Agent] send error: {e}", flush=True)
                emit("log", {"level": "error", "message": f"客服模式发送失败: {e}"})
        else:
            self._queue_pending_reply(
                channel=channel,
                content=reply,
                workflow_mode="customer",
                sender=sender,
                source="客服模式",
            )

    def _generate_customer_reply(self, content: str, channel: str, sender: str, context: str, vision_result: dict | None) -> str | None:
        route_data = (vision_result or {}).get("customer_openclaw_route")
        if isinstance(route_data, dict):
            route = OpenClawRoute(
                agent_id=str(route_data.get("agent_id") or "").strip(),
                agent_name=str(route_data.get("agent_name") or route_data.get("agent_id") or "").strip(),
                matched_keyword=str(route_data.get("matched_keyword") or "").strip(),
                extra_prompt=str(route_data.get("extra_prompt") or "").strip(),
            )
            if route.agent_id:
                try:
                    openclaw_result = self.ai.openclaw.run_agent_detail(
                        route=route,
                        message=content,
                        channel=channel,
                        sender=sender,
                        context=context,
                    )
                    reply = openclaw_result.get("reply") if openclaw_result else None
                    if reply:
                        return reply
                except Exception as e:
                    print(f"[Agent] customer OpenClaw error: {e}", flush=True)
                emit("log", {
                    "level": "warn",
                    "message": f"客服模式 OpenClaw 未返回可发送内容，agent={route.agent_id}，回退 MiniMax",
                })

        return self.ai.generate_reply(content, channel=channel, sender=sender, context=context, allow_openclaw=False)

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

    def _on_customer_escalation(self, channel: str, sender: str, content: str, reason: str) -> bool:
        if not self.running:
            return False
        self.escalation.set_reason(reason)
        emit("message", {"channel": channel, "sender": sender, "content": content})
        self._escalate(channel, sender, content)
        return True

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
            openclaw_result = self.assistant_openclaw.run_agent_detail(
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

        mode = self.config.get("mode", "auto")
        if mode != "auto":
            self._queue_pending_reply(
                channel=channel,
                content=reply,
                workflow_mode="assistant",
                sender="助手模式",
                source=route.agent_name or route.agent_id,
            )
            return True

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

    def _queue_pending_reply(self, channel: str, content: str, workflow_mode: str, sender: str = "", source: str = "") -> str:
        reply_id = uuid.uuid4().hex
        item = {
            "id": reply_id,
            "channel": channel,
            "content": content,
            "workflow_mode": workflow_mode,
            "sender": sender or "未知",
            "source": source or workflow_mode,
        }
        self.pending_replies[reply_id] = item
        emit("pending_reply", item)
        emit("log", {
            "level": "info",
            "message": f"{'助手模式' if workflow_mode == 'assistant' else '客服模式'}辅助模式待确认发送，id={reply_id[:8]}",
        })
        return reply_id

    def confirm_pending_reply(self, reply_id: str, content: str | None = None) -> bool:
        item = self.pending_replies.pop(reply_id, None)
        if not item:
            emit("log", {"level": "warn", "message": f"待发送信息不存在或已过期: {reply_id}"})
            return False

        final_content = (content if content is not None else item.get("content") or "").strip()
        if not final_content:
            emit("log", {"level": "warn", "message": "待发送信息为空，已取消发送"})
            return False

        channel = item.get("channel") or "企业微信"
        workflow_mode = item.get("workflow_mode") or "customer"
        try:
            self.operator.type_and_send(final_content, window_name=channel)
            emit("reply", {
                "content": final_content,
                "workflow_mode": workflow_mode,
                "confirmed": True,
            })
            emit("log", {
                "level": "info",
                "message": f"已确认发送辅助回复，channel={channel}，mode={workflow_mode}",
            })
            return True
        except Exception as e:
            print(f"[Agent] confirm send error: {e}", flush=True)
            emit("log", {"level": "error", "message": f"确认发送失败: {e}"})
            return False

    def cancel_pending_reply(self, reply_id: str) -> bool:
        item = self.pending_replies.pop(reply_id, None)
        if item:
            emit("log", {
                "level": "info",
                "message": f"已取消辅助回复，id={reply_id[:8]}，mode={item.get('workflow_mode')}",
            })
            return True
        emit("log", {"level": "warn", "message": f"待发送信息不存在或已取消: {reply_id}"})
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="执行单次识别后退出")
    args = parser.parse_args()

    agent = Agent()

    if args.once:
        agent.run_once()
        return

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
                elif action == "confirm_pending_reply":
                    agent.confirm_pending_reply(cmd.get("id", ""), cmd.get("content"))
                elif action == "cancel_pending_reply":
                    agent.cancel_pending_reply(cmd.get("id", ""))
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
