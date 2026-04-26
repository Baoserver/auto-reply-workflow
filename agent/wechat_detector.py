"""微信/企微消息变化监控 — 定时截屏对比检测新消息"""

import time
import threading
import hashlib
from screen_capture import ScreenCapture
from vision import VisionAnalyzer


class WeChatDetector:
    def __init__(self, capture: ScreenCapture, vision: VisionAnalyzer):
        self.capture = capture
        self.vision = vision
        self._running = False
        self._thread = None
        self._last_screenshot_hash = ""
        self._check_interval = 3

    def start(self, callback):
        """启动消息监控。callback(channel, sender, content, screenshot_path, vision_result)"""
        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, args=(callback,), daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)

    def _monitor_loop(self, callback):
        while self._running:
            try:
                self._check_windows(callback)
            except Exception:
                pass
            time.sleep(self._check_interval)

    def _check_windows(self, callback):
        """检查企业微信和微信窗口（注意顺序：先检查企业微信因为它名字包含微信）"""
        for window_name in ["企业微信", "微信"]:
            try:
                window_id = self.capture._get_window_id(window_name)
                if not window_id:
                    continue
                screenshot_path = self.capture.capture_window(window_name)
            except Exception:
                continue

            current_hash = self._file_hash(screenshot_path)
            if current_hash == self._last_screenshot_hash:
                continue
            self._last_screenshot_hash = current_hash

            try:
                result = self.vision.analyze_chat_screenshot(image_path=screenshot_path)

                if result.get("has_new_message"):
                    msg = result.get("latest_message", {})
                    sender = msg.get("sender", "未知")
                    content = msg.get("content", "")
                    if content:
                        callback(window_name, sender, content, screenshot_path, result)
            except Exception:
                pass

    @staticmethod
    def _file_hash(path: str) -> str:
        h = hashlib.md5()
        with open(path, "rb") as f:
            h.update(f.read())
        return h.hexdigest()
