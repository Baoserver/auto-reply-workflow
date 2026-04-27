"""MiniMax 视觉理解模块 — 使用 mmx-cli 精准分析截图提取消息和 UI 元素"""

import subprocess
import json
import re


def _log(level: str, message: str):
    print(json.dumps({"type": "log", "data": {"level": level, "message": message}}, ensure_ascii=False), flush=True)


class VisionAnalyzer:
    def __init__(self, config: dict):
        self.api_key = config.get("minimax", {}).get("api_key", "")
        self.model = config.get("minimax", {}).get("vision_model", "MiniMax-VL-01")
        self.timeout_seconds = int(config.get("minimax", {}).get("vision_timeout_seconds", 60))
        self.mmx_path = "/opt/homebrew/bin/mmx"

    def analyze_chat_screenshot(self, image_path: str = None, mode: str = "customer") -> dict:
        if not image_path:
            return self._empty_result(mode)

        prompt = self._build_prompt(mode)

        cmd = [
            self.mmx_path,
            "--api-key", self.api_key,
            "vision", "describe",
            "--image", image_path,
            "--prompt", prompt,
            "--output", "json"
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout_seconds)
            output = result.stdout.strip()
            _log("info", f"Vision API 返回码={result.returncode}, stdout长度={len(output)}")

            if result.returncode != 0:
                _log("error", f"Vision API 失败: stderr={result.stderr[:500]}")
                return self._empty_result(mode)

            if not output:
                _log("warn", "Vision API 返回空输出")
                return self._empty_result(mode)

            # 尝试从 mmx JSON 输出中提取内容
            try:
                data = json.loads(output)
                content = data.get("content", "")
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False)
                match = re.search(r"```json\s*(.*?)\s*```", content, re.DOTALL)
                if match:
                    content = match.group(1)
                parsed = json.loads(content)
                if mode == "assistant":
                    _log("info", f"Vision 助手解析成功: messages={len(parsed.get('recent_messages', []))}")
                else:
                    _log("info", f"Vision 解析成功: sender={parsed.get('latest_message',{}).get('sender','')}, has_new={parsed.get('has_new_message')}")
                return parsed
            except (json.JSONDecodeError, KeyError):
                _log("warn", f"Vision JSON 解析失败，尝试直接解析 output")
                try:
                    parsed = json.loads(output)
                    _log("info", f"Vision 直接解析成功: {list(parsed.keys())}")
                    return parsed
                except Exception:
                    _log("error", f"Vision 输出非JSON: {output[:300]}")
                    return self._empty_result(mode)
        except subprocess.TimeoutExpired:
            _log("error", f"Vision API 超时 ({self.timeout_seconds}s)")
            return self._empty_result(mode)
        except Exception as e:
            _log("error", f"Vision 异常: {e}")
            return self._empty_result(mode)

    def _build_prompt(self, mode: str) -> str:
        if mode == "assistant":
            return """分析这张微信/企业微信聊天区域截图，以JSON格式返回当前截图中可见的完整上下文信息。
要求：
1. recent_messages: 当前可见聊天区里能识别出的全部最近对话，按从旧到新的顺序返回，每条包含 sender、content、is_self。
2. conversation_text: 当前可见聊天区完整上下文摘要，尽量保留事实、任务状态、我方和对方的关键表达。
3. visible_text: 当前截图中可见的聊天文字，按阅读顺序尽量完整转写。
4. input_box: 输入框的相对位置坐标 [x_ratio, y_ratio]（0-1之间）。
5. send_button: 发送按钮的相对位置 [x_ratio, y_ratio]。
6. chat_list_area: 聊天区域的大致范围 [x1, y1, x2, y2]。

不要判断是否需要客服回复，不要返回 latest_message，不要返回 has_new_message。
请严格按以下JSON格式返回，不要添加其他内容：
{"recent_messages":[{"sender":"","content":"","is_self":false}],"conversation_text":"","visible_text":"","input_box":[0.5,0.9],"send_button":[0.95,0.9],"chat_list_area":[0,0,1,1]}"""

        return """分析这张微信/企业微信聊天区域截图，以JSON格式返回以下信息：
1. recent_messages: 当前可见聊天区里能识别出的最近对话，按从旧到新的顺序返回，每条包含 sender、content、is_self。
2. latest_message: 最新一条需要客服回复的客户消息，不要选择我方已经发送的消息、系统消息、时间、联系人名或状态文字。
3. conversation_text: 当前可见聊天区的完整对话文字摘要，尽量保留客户问题和我方最近回复。
4. input_box: 输入框的相对位置坐标 [x_ratio, y_ratio]（0-1之间）。
5. has_new_message: 是否有新的客户消息需要回复(boolean)。
6. send_button: 发送按钮的相对位置 [x_ratio, y_ratio]。
7. chat_list_area: 聊天区域的大致范围 [x1, y1, x2, y2]。

请严格按以下JSON格式返回，不要添加其他内容：
{"recent_messages":[{"sender":"","content":"","is_self":false}],"latest_message":{"sender":"","content":""},"conversation_text":"","input_box":[0.5,0.9],"has_new_message":false,"send_button":[0.95,0.9],"chat_list_area":[0,0,1,1]}"""

    def _empty_result(self, mode: str) -> dict:
        if mode == "assistant":
            return {
                "recent_messages": [],
                "conversation_text": "",
                "visible_text": "",
                "input_box": None,
                "send_button": None,
                "chat_list_area": None,
            }
        return {"has_new_message": False, "latest_message": {"sender": "", "content": ""}}
