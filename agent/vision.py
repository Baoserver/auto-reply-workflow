"""MiniMax 视觉理解模块 — 使用 mmx-cli 分析截图提取消息和 UI 元素"""

import subprocess
import json


class VisionAnalyzer:
    def __init__(self, config: dict):
        self.api_key = config.get("minimax", {}).get("api_key", "")
        self.model = config.get("minimax", {}).get("vision_model", "MiniMax-VL-01")
        self.mmx_path = "/opt/homebrew/bin/mmx"

    def analyze_chat_screenshot(self, image_base64: str = None, image_path: str = None) -> dict:
        """
        分析聊天截图，提取：
        - 最新消息的发送者和内容
        - 输入框位置坐标
        - 是否有未读消息

        使用 mmx-cli vision describe 命令
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

            # 解析 JSON 输出
            try:
                data = json.loads(output)
                content = data.get("content", "")

                # 从 markdown 代码块中提取 JSON
                import re
                match = re.search(r"```json\s*(.*?)\s*```", content, re.DOTALL)
                if match:
                    content = match.group(1)

                return json.loads(content)
            except (json.JSONDecodeError, KeyError):
                # 尝试直接解析
                try:
                    return json.loads(output)
                except:
                    return {"latest_message": {"sender": "", "content": ""}, "has_new_message": False}
        except Exception as e:
            print(f"Vision analysis error: {e}")
            return {"latest_message": {"sender": "", "content": ""}, "has_new_message": False}

    def detect_channel(self, image_path: str = None) -> str:
        """判断截图是微信还是企业微信"""
        if not image_path:
            return "未知"

        cmd = [
            self.mmx_path,
            "--api-key", self.api_key,
            "vision", "describe",
            "--image", image_path,
            "--prompt", "这是微信还是企业微信的界面？只回答'微信'或'企业微信'",
            "--output", "json"
        ]

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            output = result.stdout.strip()

            data = json.loads(output)
            content = data.get("content", "")

            if "企业" in content:
                return "企业微信"
            return "微信"
        except:
            return "未知"
