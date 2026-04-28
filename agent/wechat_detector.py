"""微信/企微消息变化监控 — 两阶段检测：本地OCR过滤 + 按需视觉分析"""

import time
import threading
import hashlib
import re
import json
import os
from dataclasses import dataclass
from PIL import Image
from screen_capture import ScreenCapture
from screen_capture import cleanup_screenshots_dir
from vision import VisionAnalyzer
from local_ocr import LocalOCR
from openclaw_client import OpenClawClient


# 系统/通知类消息，不应触发客服回复
SYSTEM_PATTERNS = [
    "撤回了一条消息", "拍了拍", "加入了群聊", "修改群名为",
    "邀请", "进入了聊天", "移出了群聊", "成为新群主",
    "开启了群聊邀请", "关闭了群聊邀请", "修改了群聊名称",
    "以上是历史消息", "Messages to this chat",
    "你已添加了", "现在可以开始聊天",
    "快速会议",
]

# 自身发送者名称（避免循环）
SELF_SENDERS = {"我", "me", "AI", "自己", "self", "本人", "文件传输助手", "文件传输", "传输助手", "WeChat", "微信团队", "系统消息"}


def emit_log(level: str, message: str):
    print(json.dumps({"type": "log", "data": {"level": level, "message": message}}, ensure_ascii=False), flush=True)


def emit(event_type: str, data: dict):
    print(json.dumps({"type": event_type, "data": data}, ensure_ascii=False), flush=True)


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
        self.openclaw = OpenClawClient(config)
        self.workflow_mode = config.get("workflow_mode", "customer")

        self._running = False
        self._thread = None
        self._check_interval = config.get("ocr", {}).get("check_interval", 3)

        self._window_states: dict[str, WindowState] = {}
        self._processed_hashes: list[str] = []
        self._max_dedup = 100

        ocr_cfg = config.get("ocr", {})
        self.trigger_keywords = [k.strip() for k in ocr_cfg.get("trigger_keywords", "").split(",") if k.strip()]
        # 自动合并 OpenClaw 路由关键词到触发词
        for route in config.get("openclaw", {}).get("routes", []):
            if route.get("enabled", True):
                for kw in str(route.get("keywords", "")).replace("，", ",").split(","):
                    kw = kw.strip()
                    if kw and kw not in self.trigger_keywords:
                        self.trigger_keywords.append(kw)
        # 聊天区域裁剪 (left_ratio, top_ratio, right_ratio, bottom_ratio)，默认取右 65%
        self.chat_region_mode = ocr_cfg.get("chat_region_mode", "auto")
        region_cfg = ocr_cfg.get("chat_region", [0.35, 0.0, 1.0, 1.0])
        self.chat_region = tuple(region_cfg) if region_cfg else None
        self._first_check_logged = set()

    def start(self, callback, assistant_callback=None):
        self._running = True
        self._thread = threading.Thread(target=self._monitor_loop, args=(callback, assistant_callback), daemon=True)
        self._thread.start()
        mode_label = "助手模式" if self.workflow_mode == "assistant" else "客服模式"
        emit_log("info", f"检测器已启动，模式={mode_label}，间隔 {self._check_interval}s，本地OCR={'开启' if self.local_ocr.enabled else '关闭'}，触发词: {self.trigger_keywords or '(无，全部放行)'}")

    def check_once(self, callback, assistant_callback=None):
        mode_label = "助手模式" if self.workflow_mode == "assistant" else "客服模式"
        emit_log("info", f"单次识别开始，模式={mode_label}，本地OCR={'开启' if self.local_ocr.enabled else '关闭'}")
        self._check_windows(callback, assistant_callback)
        emit_log("info", "单次识别完成")

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)

    def _monitor_loop(self, callback, assistant_callback=None):
        while self._running:
            try:
                self._check_windows(callback, assistant_callback)
            except Exception as e:
                emit_log("error", f"检测循环异常: {e}")
            time.sleep(self._check_interval)

    def _check_windows(self, callback, assistant_callback=None):
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
            vision_image_path = screenshot_path

            if self.local_ocr.enabled:
                try:
                    ocr_image, crop_mode, crop_box = self._crop_chat_region(screenshot_path)
                    vision_image_path = ocr_image
                    with Image.open(ocr_image) as img:
                        emit_log(
                            "info",
                            f"[{window_name}] OCR裁剪图: {os.path.basename(ocr_image)} "
                            f"({img.size[0]}x{img.size[1]}), mode={crop_mode}, box={crop_box}",
                        )
                    ocr_text = self._extract_ocr_text_without_watermark(ocr_image, window_name)
                    if ocr_text:
                        new_lines = self._diff_new_lines(state.ocr_text, ocr_text)
                        emit_log("info", f"[{window_name}] OCR提取 {len(ocr_text)} 字符，新增 {len(new_lines)} 行")
                        emit("ocr", {"window": window_name, "new_lines": new_lines, "full_text": ocr_text})
                        ocr_success = True
                    else:
                        emit_log("warn", f"[{window_name}] 本地OCR返回空结果，将直接使用视觉API")
                except Exception as e:
                    emit_log("error", f"本地OCR异常: {e}")

            state.ocr_text = ocr_text
            state.screenshot_path = screenshot_path

            if self.workflow_mode == "assistant" and not ocr_success:
                emit_log("warn", f"[{window_name}] 助手模式需要 OCR 新增行做路由，当前无可用 OCR，跳过")
                self._maybe_cleanup_screenshot(screenshot_path)
                continue

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

                last_message = self._last_meaningful_line(new_lines)
                if not last_message:
                    emit_log("info", f"[{window_name}] 未找到最后有效消息，跳过")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

                emit_log("info", f"[{window_name}] OCR最后有效消息: {last_message}")
                msg_hash = hashlib.md5(last_message.encode("utf-8")).hexdigest()
                if msg_hash in self._processed_hashes:
                    emit_log("info", f"[{window_name}] 重复消息，跳过")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

                if self.workflow_mode == "assistant":
                    self._handle_assistant_workflow(
                        window_name=window_name,
                        screenshot_path=screenshot_path,
                        vision_image_path=vision_image_path,
                        last_message=last_message,
                        dedup_key=msg_hash,
                        assistant_callback=assistant_callback,
                    )
                    continue

                # 触发词检查
                if self.trigger_keywords and not self._match_trigger(last_message):
                    emit_log("info", f"[{window_name}] 最后有效消息未命中触发词，跳过视觉API: {last_message}")
                    self._maybe_cleanup_screenshot(screenshot_path)
                    continue

            # 去重（OCR 不可用时基于截图 hash）
            dedup_key = current_hash
            if dedup_key in self._processed_hashes:
                self._maybe_cleanup_screenshot(screenshot_path)
                continue

            # 阶段二：调用 mmx-cli 视觉API
            emit_log("info", f"[{window_name}] 调用视觉API精准分析: {os.path.basename(vision_image_path)}")
            try:
                result = self.vision.analyze_chat_screenshot(image_path=vision_image_path, mode="customer")
                emit("vision", {"window": window_name, "result": result})
                emit_log("info", f"[{window_name}] Vision识别结果: {json.dumps(self._summarize_vision_result(result), ensure_ascii=False)}")

                if result.get("has_new_message"):
                    msg = result.get("latest_message", {})
                    sender = msg.get("sender", "未知")
                    content = msg.get("content", "")

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

    def _handle_assistant_workflow(
        self,
        window_name: str,
        screenshot_path: str,
        vision_image_path: str,
        last_message: str,
        dedup_key: str,
        assistant_callback,
    ):
        route = self.openclaw.match_route(last_message)
        if not route:
            emit_log("info", f"[{window_name}] 助手模式最后有效消息未命中 OpenClaw 路由，跳过: {last_message}")
            self._maybe_cleanup_screenshot(screenshot_path)
            return

        if not assistant_callback:
            emit_log("warn", f"[{window_name}] 助手模式缺少回调，跳过 OpenClaw 处理")
            self._maybe_cleanup_screenshot(screenshot_path)
            return

        emit_log("info", f"[{window_name}] 助手模式命中路由: agent={route.agent_id}, keyword={route.matched_keyword}")
        emit_log("info", f"[{window_name}] 助手模式调用视觉API完整识别: {os.path.basename(vision_image_path)}")

        try:
            result = self.vision.analyze_chat_screenshot(image_path=vision_image_path, mode="assistant")
            if not self._assistant_vision_has_content(result):
                emit_log("error", f"[{window_name}] 助手模式 Vision 未返回有效上下文，跳过 OpenClaw")
                self._maybe_cleanup_screenshot(screenshot_path)
                return

            result["workflow_mode"] = "assistant"
            result["matched_keyword"] = route.matched_keyword
            result["route_agent"] = {"id": route.agent_id, "name": route.agent_name}
            emit("vision", {"window": window_name, "result": result})
            emit_log("info", f"[{window_name}] Vision识别结果: {json.dumps(self._summarize_vision_result(result), ensure_ascii=False)}")

            handled = assistant_callback(window_name, route, last_message, screenshot_path, result)
            if handled:
                self._processed_hashes.append(dedup_key)
                if len(self._processed_hashes) > self._max_dedup:
                    self._processed_hashes = self._processed_hashes[-self._max_dedup:]
                self._maybe_cleanup_screenshot(screenshot_path, keep=True)
            else:
                self._maybe_cleanup_screenshot(screenshot_path)
        except Exception as e:
            emit_log("error", f"助手模式视觉/OpenClaw流程异常: {e}")
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

    def _last_meaningful_line(self, lines: list[str]) -> str:
        for line in reversed(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if self._is_system_message(stripped):
                continue
            if self._is_time_like_line(stripped):
                continue
            return stripped
        return ""

    def _is_time_like_line(self, text: str) -> bool:
        stripped = text.strip().strip("|")
        if re.fullmatch(r"\d{1,2}:\d{2}", stripped):
            return True
        if re.fullmatch(r"(今天|昨天|前天)?\s*\d{1,2}:\d{2}", stripped):
            return True
        if re.fullmatch(r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?", stripped):
            return True
        return False

    def _match_trigger(self, text: str) -> bool:
        """检查最后有效消息是否命中触发词，命中返回 True"""
        for kw in self.trigger_keywords:
            if kw in text:
                return True
        return False

    def _summarize_vision_result(self, result: dict) -> dict:
        if not isinstance(result, dict):
            return {}
        recent_messages = result.get("recent_messages")
        if not isinstance(recent_messages, list):
            recent_messages = []
        return {
            "has_new_message": result.get("has_new_message", False),
            "latest_message": result.get("latest_message", {}),
            "recent_messages": recent_messages[-12:],
            "conversation_text": result.get("conversation_text", ""),
            "visible_text": result.get("visible_text", ""),
            "workflow_mode": result.get("workflow_mode", self.workflow_mode),
            "matched_keyword": result.get("matched_keyword", ""),
            "route_agent": result.get("route_agent", {}),
        }

    def _assistant_vision_has_content(self, result: dict) -> bool:
        if not isinstance(result, dict):
            return False
        if str(result.get("conversation_text") or "").strip():
            return True
        if str(result.get("visible_text") or "").strip():
            return True
        recent_messages = result.get("recent_messages")
        return isinstance(recent_messages, list) and len(recent_messages) > 0

    def _maybe_cleanup_screenshot(self, path: str, keep: bool = False):
        cleanup_screenshots_dir()

    def _cleanup_old_files(self):
        """兼容旧调用：只保留最新 30 个截图文件。"""
        cleanup_screenshots_dir()

    @staticmethod
    def _file_hash(path: str) -> str:
        h = hashlib.md5()
        with open(path, "rb") as f:
            h.update(f.read())
        return h.hexdigest()

    def _crop_chat_region(self, image_path: str) -> tuple[str, str, tuple[int, int, int, int]]:
        img = Image.open(image_path)
        w, h = img.size
        if not self.chat_region:
            return image_path, "full", (0, 0, w, h)

        crop_box = None
        crop_mode = "fixed"
        if self.chat_region_mode == "auto":
            crop_box, crop_mode = self._detect_chat_region(image_path, img, w, h)
            if crop_box:
                pass

        if not crop_box:
            crop_box = self._fixed_chat_region_box(w, h)
            crop_mode = "fallback_fixed" if self.chat_region_mode == "auto" else "fixed"

        return self._crop_region(image_path, crop_box, crop_mode)

    def _fixed_chat_region_box(self, width: int, height: int) -> tuple[int, int, int, int]:
        left, top, right, bottom = self.chat_region
        return (
            int(left * width),
            int(top * height),
            int(right * width),
            int(bottom * height),
        )

    def _detect_chat_region(self, image_path: str, img: Image.Image, width: int, height: int) -> tuple[tuple[int, int, int, int] | None, str]:
        lines = self.local_ocr.extract_text(image_path)
        candidates = []
        for line in lines:
            text = line.text.strip()
            if not text:
                continue
            x1 = float(line.x)
            y1 = float(line.y)
            x2 = x1 + float(line.width)
            y2 = y1 + float(line.height)
            if y2 < 0.05 or y1 > 0.94:
                continue
            if x2 < 0.10:
                continue
            if line.width < 0.006 or line.height < 0.006:
                continue
            candidates.append(line)

        separator_x = self._detect_vertical_separator(img)
        if separator_x is not None:
            left = min(width - 1, separator_x + 8)
            box = (left, 0, width, height)
            if self._is_valid_auto_box(box, width, height) and self._has_right_side_text(candidates, left / width):
                return box, "auto_separator"

        if len(candidates) < 8:
            return None, "auto_ocr_gap"

        boundary = self._infer_chat_left_boundary(candidates)
        if boundary is None:
            return None, "auto_ocr_gap"

        left = int(max(0, min(0.62, boundary - 0.015)) * width)
        box = (left, 0, width, height)
        if not self._is_valid_auto_box(box, width, height):
            return None, "auto_ocr_gap"
        return box, "auto_ocr_gap"

    def _detect_vertical_separator(self, img: Image.Image) -> int | None:
        rgb = img.convert("RGB")
        width, height = rgb.size
        x_start = int(width * 0.18)
        x_end = int(width * 0.45)
        y_start = int(height * 0.08)
        y_end = int(height * 0.92)
        if x_end <= x_start or y_end <= y_start:
            return None

        candidates = []
        for x in range(x_start, x_end):
            score, coverage = self._vertical_separator_score(rgb, x, y_start, y_end)
            if coverage < 0.32:
                continue
            if score < 28:
                continue
            candidates.append((score * coverage, score, coverage, x))

        if not candidates:
            return None

        high_confidence = [(x, score) for _, score, coverage, x in candidates if coverage >= 0.75 and score >= 35]
        if high_confidence:
            return self._pick_separator_from_high_confidence(high_confidence)

        candidates.sort(reverse=True)
        for _, _, _, x in candidates[:12]:
            if self._is_stable_separator(rgb, x, y_start, y_end):
                return x
        return None

    @staticmethod
    def _pick_separator_from_high_confidence(candidates: list[tuple[int, float]]) -> int:
        candidates.sort()
        groups: list[list[tuple[int, float]]] = []
        for item in candidates:
            if not groups or item[0] - groups[-1][-1][0] > 12:
                groups.append([item])
            else:
                groups[-1].append(item)

        best_group = max(groups, key=lambda group: (len(group), sum(score for _, score in group) / len(group)))
        return max(x for x, _ in best_group)

    @staticmethod
    def _vertical_separator_score(img: Image.Image, x: int, y_start: int, y_end: int) -> tuple[float, float]:
        total = 0.0
        hits = 0
        samples = 0
        width, _ = img.size
        left_x = max(0, x - 3)
        right_x = min(width - 1, x + 3)
        for y in range(y_start, y_end, 6):
            left = img.getpixel((left_x, y))
            right = img.getpixel((right_x, y))
            diff = sum(abs(left[i] - right[i]) for i in range(3))
            total += diff
            if diff >= 24:
                hits += 1
            samples += 1
        if samples == 0:
            return 0.0, 0.0
        return total / samples, hits / samples

    @staticmethod
    def _is_stable_separator(img: Image.Image, x: int, y_start: int, y_end: int) -> bool:
        width, _ = img.size
        left_x = max(0, x - 8)
        right_x = min(width - 1, x + 8)
        stable_hits = 0
        samples = 0
        for y in range(y_start, y_end, 10):
            left = img.getpixel((left_x, y))
            right = img.getpixel((right_x, y))
            diff = sum(abs(left[i] - right[i]) for i in range(3))
            if diff >= 18:
                stable_hits += 1
            samples += 1
        return samples > 0 and stable_hits / samples >= 0.25

    @staticmethod
    def _has_right_side_text(lines, boundary: float) -> bool:
        return sum(1 for line in lines if line.x >= boundary and 0.06 <= line.y <= 0.92) >= 4

    def _infer_chat_left_boundary(self, lines) -> float | None:
        starts = sorted(line.x for line in lines if 0.12 <= line.x <= 0.70)
        if len(starts) < 8:
            return None

        best_gap = None
        for i in range(len(starts) - 1):
            left = starts[i]
            right = starts[i + 1]
            gap = right - left
            midpoint = (left + right) / 2
            if not 0.24 <= midpoint <= 0.52:
                continue
            left_count = sum(1 for x in starts if x <= left)
            right_count = sum(1 for x in starts if x >= right)
            if left_count < 5 or right_count < 4:
                continue
            if gap < 0.025:
                continue
            if best_gap is None or gap > best_gap[0]:
                best_gap = (gap, midpoint)

        if best_gap:
            return best_gap[1]

        left_panel = [
            line.x + line.width
            for line in lines
            if 0.10 <= line.x <= 0.34 and line.x + line.width <= 0.38
        ]
        right_side_count = sum(1 for line in lines if line.x >= 0.34)
        if len(left_panel) >= 5 and right_side_count >= 4:
            return min(max(left_panel) + 0.02, 0.52)
        return None

    @staticmethod
    def _is_valid_auto_box(box: tuple[int, int, int, int], width: int, height: int) -> bool:
        left, top, right, bottom = box
        box_width = right - left
        box_height = bottom - top
        if box_width < max(320, int(width * 0.36)):
            return False
        if box_height < max(360, int(height * 0.55)):
            return False
        if left < int(width * 0.18):
            return False
        if left > int(width * 0.65):
            return False
        return True

    def _extract_ocr_text_without_watermark(self, image_path: str, window_name: str) -> str:
        lines = self.local_ocr.extract_text(image_path)
        if not lines:
            return ""

        with Image.open(image_path) as img:
            rgb = img.convert("RGB")
            kept = []
            removed = []
            for line in lines:
                text = line.text.strip()
                if not text:
                    continue
                if self._is_system_message(text):
                    continue
                if self._is_low_contrast_watermark_line(rgb, line):
                    removed.append(text)
                    continue
                kept.append(text)

        if removed:
            emit_log("info", f"[{window_name}] OCR过滤水印 {len(removed)} 行: {removed[:5]}")
        return "\n".join(kept)

    @staticmethod
    def _is_low_contrast_watermark_line(img: Image.Image, line) -> bool:
        width, height = img.size
        x1 = max(0, int(line.x * width) - 2)
        x2 = min(width, int((line.x + line.width) * width) + 2)
        # Vision OCR uses a bottom-left origin; PIL uses top-left.
        y1 = max(0, int((1 - line.y - line.height) * height) - 2)
        y2 = min(height, int((1 - line.y) * height) + 2)
        if x2 <= x1 or y2 <= y1:
            return False

        total = 0
        dark = 0
        very_dark = 0
        min_luminance = 255.0
        for y in range(y1, y2):
            for x in range(x1, x2):
                r, g, b = img.getpixel((x, y))
                luminance = (r + g + b) / 3
                min_luminance = min(min_luminance, luminance)
                if luminance < 170:
                    dark += 1
                if luminance < 120:
                    very_dark += 1
                total += 1

        if total == 0:
            return False

        dark_ratio = dark / total
        very_dark_ratio = very_dark / total
        return min_luminance >= 150 and dark_ratio < 0.035 and very_dark_ratio < 0.01

    def _crop_region(self, image_path: str, box: tuple[int, int, int, int], mode: str) -> tuple[str, str, tuple[int, int, int, int]]:
        img = Image.open(image_path)
        cropped = img.crop(box)
        cropped_path = image_path.replace(".png", "_chat.png")
        cropped.save(cropped_path, "PNG")
        cleanup_screenshots_dir()
        return cropped_path, mode, box
