"""微信/企微消息变化监控 — 两阶段检测：本地OCR过滤 + 按需视觉分析"""

import time
import threading
import hashlib
import re
import json
import os
from dataclasses import dataclass
from screen_capture import ScreenCapture
from vision import VisionAnalyzer
from local_ocr import LocalOCR


# 系统/通知类消息，不应触发客服回复
SYSTEM_PATTERNS = [
    "撤回了一条消息", "拍了拍", "加入了群聊", "修改群名为",
    "邀请", "进入了聊天", "移出了群聊", "成为新群主",
    "开启了群聊邀请", "关闭了群聊邀请", "修改了群聊名称",
    "以上是历史消息", "Messages to this chat",
    "你已添加了", "现在可以开始聊天",
]

# 自身发送者名称（避免循环）
SELF_SENDERS = {"我", "me", "AI", "自己", "self", "本人", "文件传输助手", "文件传输", "传输助手", "WeChat", "微信团队", "系统消息"}


def emit_log(level: str, message: str):
    print(json.dumps({"type": "log", "data": {"level": level, "message": message}}, ensure_ascii=False), flush=True)


@dataclass
class WindowState:
    hash: str = ""
    ocr_text: str = ""
    screenshot_path: str = ""
    ocr_fail_count: int = 0


class WeChatDetector:
    def __init__(self, capture: ScreenCapture, vision: VisionAnalyzer, config: dict):
        self.capture = capture
        self.vision = vision
        self.config = config
        self.local_ocr = LocalOCR(config)

        self._running = False
        self._thread = None
        self._check_interval = config.get("ocr", {}).get("check_interval", 3)

        self._window_states: dict[str, WindowState] = {}
        self._processed_hashes: list[str] = []
        self._max_dedup = 100

        ocr_cfg = config.get("ocr", {})
        self.trigger_keywords = [k.strip() for k in ocr_cfg.get("trigger_keywords", "").split(",") if k.strip()]
        self.chat_region = None
        self._first_check_logged = set()

    def start(self, callback):
        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, args=(callback,), daemon=True)
        self._thread.start()
        emit_log("info", f"检测器已启动，间隔 {self._check_interval}s，本地OCR={'开启' if self.local_ocr.enabled else '关闭'}，触发词: {self.trigger_keywords or '(无，全部放行)'}")

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)

    def _monitor_loop(self, callback):
        while self._running:
            try:
                self._check_windows(callback)
            except Exception as e:
                emit_log("error", f"检测循环异常: {e}")
            time.sleep(self._check_interval)

    def _check_windows(self, callback):
        windows = []
        if self.config.get("wecom", {}).get("enabled", True):
            windows.append("企业微信")
        if self.config.get("wechat", {}).get("enabled", True):
            windows.append("微信")

        for window_name in windows:
            try:
                window_id = self.capture._get_window_id(window_name)
                if not window_id:
                    if window_name not in self._first_check_logged:
                        self._first_check_logged.add(window_name)
                        emit_log("warn", f"未检测到 [{window_name}] 窗口，请确认已打开并登录")
                    continue

                if window_name not in self._first_check_logged:
                    self._first_check_logged.add(window_name)
                    emit_log("info", f"已检测到 [{window_name}] 窗口 (id={window_id})，开始监控")

                screenshot_path = self.capture.capture_window(window_name)
            except Exception as e:
                emit_log("error", f"截屏 [{window_name}] 失败: {e}")
                continue

            if not os.path.exists(screenshot_path) or os.path.getsize(screenshot_path) < 1000:
                state = self._window_states.setdefault(window_name, WindowState())
                state.ocr_fail_count += 1
                if state.ocr_fail_count == 1:
                    emit_log("error", f"[{window_name}] 截图失败或文件过小，请检查系统设置 > 隐私与安全 > 屏幕录制权限")
                self._maybe_cleanup_screenshot(screenshot_path)
                continue

            current_hash = self._file_hash(screenshot_path)
            state = self._window_states.setdefault(window_name, WindowState())
            state.ocr_fail_count = 0

            if current_hash == state.hash:
                self._maybe_cleanup_screenshot(screenshot_path)
                continue
            state.hash = current_hash

            emit_log("info", f"[{window_name}] 画面变化，开始本地OCR分析")

            # 阶段一：本地 OCR
            ocr_text = ""
            new_lines = []
            ocr_success = False

            if self.local_ocr.enabled:
                try:
                    ocr_text = self.local_ocr.extract_text_string(screenshot_path)
                    if ocr_text:
                        new_lines = self._diff_new_lines(state.ocr_text, ocr_text)
                        emit_log("info", f"[{window_name}] OCR提取 {len(ocr_text)} 字符，新增 {len(new_lines)} 行")
                        ocr_success = True
                    else:
                        emit_log("warn", f"[{window_name}] 本地OCR返回空结果，将直接使用视觉API")
                except Exception as e:
                    emit_log("error", f"本地OCR异常: {e}")

            state.ocr_text = ocr_text
            state.screenshot_path = screenshot_path

            # OCR 有效时的过滤
            if ocr_success:
                if not new_lines:
                    emit_log("info", f"[{window_name}] 无新增文字，跳过")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

                meaningful_lines = [line for line in new_lines if not self._is_system_message(line)]
                if not meaningful_lines:
                    emit_log("info", f"[{window_name}] 新增内容均为系统消息，跳过")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

                combined_text = "\n".join(meaningful_lines)
                msg_hash = hashlib.md5(combined_text.encode("utf-8")).hexdigest()
                if msg_hash in self._processed_hashes:
                    emit_log("info", f"[{window_name}] 重复消息，跳过")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

                # 触发词检查
                if self.trigger_keywords and not self._match_trigger(meaningful_lines):
                    emit_log("info", f"[{window_name}] 未命中触发词，跳过视觉API: {meaningful_lines[:3]}")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

            # 去重（OCR 不可用时基于截图 hash）
            dedup_key = current_hash
            if dedup_key in self._processed_hashes:
                self._maybe_cleanup_screenshot(screenshot_path)
                continue

            # 阶段二：调用 mmx-cli 视觉API
            emit_log("info", f"[{window_name}] 调用视觉API精准分析")
            try:
                result = self.vision.analyze_chat_screenshot(image_path=screenshot_path)

                if result.get("has_new_message"):
                    msg = result.get("latest_message", {})
                    sender = msg.get("sender", "未知")
                    content = msg.get("content", "")

                    if sender in SELF_SENDERS or any(s in sender for s in ("文件传输", "助手")):
                        self._maybe_cleanup_screenshot(screenshot_path)
                        continue

                    if content:
                        self._processed_hashes.append(dedup_key)
                        if len(self._processed_hashes) > self._max_dedup:
                            self._processed_hashes = self._processed_hashes[-self._max_dedup:]
                        callback(window_name, sender, content, screenshot_path, result)
                        self._maybe_cleanup_screenshot(screenshot_path, keep=True)
                    else:
                        self._maybe_cleanup_screenshot(screenshot_path)
                else:
                    emit_log("info", f"[{window_name}] 视觉API未识别到新消息")
                    self._maybe_cleanup_screenshot(screenshot_path)
            except Exception as e:
                emit_log("error", f"视觉API异常: {e}")
                self._maybe_cleanup_screenshot(screenshot_path)

    def _diff_new_lines(self, old_text: str, new_text: str) -> list[str]:
        if not old_text:
            return [line.strip() for line in new_text.split("\n") if line.strip()]
        old_lines = set(line.strip() for line in old_text.split("\n") if line.strip())
        result = []
        for line in new_text.split("\n"):
            stripped = line.strip()
            if stripped and stripped not in old_lines:
                result.append(stripped)
        return result

    def _is_system_message(self, text: str) -> bool:
        for pattern in SYSTEM_PATTERNS:
            if pattern in text:
                return True
        if not re.search(r'[\u4e00-\u9fff\u3000-\u303f\w]', text):
            return True
        return False

    def _match_trigger(self, lines: list[str]) -> bool:
        """检查新增内容是否命中触发词，命中返回 True"""
        combined = "".join(lines)
        for kw in self.trigger_keywords:
            if kw in combined:
                return True
        return False

    def _maybe_cleanup_screenshot(self, path: str, keep: bool = False):
        if keep:
            return
        try:
            p = os.path.normpath(path)
            if os.path.exists(p) and "screenshots" in p:
                os.unlink(p)
        except Exception:
            pass

    @staticmethod
    def _file_hash(path: str) -> str:
        h = hashlib.md5()
        with open(path, "rb") as f:
            h.update(f.read())
        return h.hexdigest()
