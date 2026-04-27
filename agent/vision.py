"""MiniMax 视觉理解模块 — 使用 mmx-cli 精准分析截图提取消息和 UI 元素"""

import subprocess
import json
import re


class VisionAnalyzer:
    def __init__(self, config: dict):
        self.api_key = config.get("minimax", {}).get("api_key", "")
        self.model = config.get("minimax", {}).get("vision_model", "MiniMax-VL-01")
        self.mmx_path = "/opt/homebrew/bin/mmx"

    def analyze_chat_screenshot(self, image_path: str = None) -> dict:
        """
        精准分析聊天截图（由 WeChatDetector 在本地 OCR 检测到新消息后调用）。
        提取：最新消息的发送者和内容、输入框坐标、是否有未读消息。
        """
        if not image_path:
            return {"has_new_message": False, "latest_message": {"sender": "", "content": ""}}

        prompt = """分析这张微信/企业微信聊天截图，以JSON格式返回以下信息：
1. latest_message: 最新一条消息的发送者(sender)和内容(content)
2. input_box: 输入框的相对位置坐标 [x_ratio, y_ratio]（0-1之间）
3. has_new_message: 是否有未读消息(boolean)
4. send_button: 发送按钮的相对位置 [x_ratio, y_ratio]
5. chat_list_area: 聊天区域的大致范围 [x1, y1, x2, y2]

请严格按以下JSON格式返回，不要添加其他内容：
{"latest_message":{"sender":"","content":""},"input_box":[0.5,0.9],"has_new_message":false,"send_button":[0.95,0.9],"chat_list_area":[0,0,1,1]}"""

        cmd = [
            self.mmx_path,
            "--api-key", self.api_key,
            "vision", "describe",
            "--image", image_path,
            "--prompt", prompt,
            "--output", "json"
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            output = result.stdout.strip()

            try:
                data = json.loads(output)
                content = data.get("content", "")
                match = re.search(r"```json\s*(.*?)\s*```", content, re.DOTALL)
                if match:
                    content = match.group(1)
                return json.loads(content)
            except (json.JSONDecodeError, KeyError):
                try:
                    return json.loads(output)
                except Exception:
                    return {"latest_message": {"sender": "", "content": ""}, "has_new_message": False}
        except Exception as e:
            print(f"Vision analysis error: {e}")
            return {"latest_message": {"sender": "", "content": ""}, "has_new_message": False}
