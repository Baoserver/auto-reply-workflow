"""macOS 截屏模块 — 捕获微信/企微窗口"""

import subprocess
import os
from pathlib import Path
from Quartz import CGWindowListCopyWindowInfo, CGWindowListCreateImage, kCGNullWindowID, kCGWindowListOptionAll, kCGWindowListExcludeDesktopElements

SCREENSHOTS_DIR = os.path.expanduser("~/Desktop/screenshots")

def _ensure_screenshots_dir():
    Path(SCREENSHOTS_DIR).mkdir(parents=True, exist_ok=True)

class ScreenCapture:
    def _get_window_id(self, window_name: str) -> str:
        """通过 Quartz 获取窗口 ID，选择最大的窗口"""
        try:
            windows = CGWindowListCopyWindowInfo(kCGWindowListExcludeDesktopElements, kCGNullWindowID)
            best_window = None
            best_area = 0
            for win in windows:
                owner = win.get('kCGWindowOwnerName', '')
                # 精确匹配：先检查完全匹配，再检查简化后的匹配
                # 避免"企业微信"被误认为"微信"
                owner_clean = owner.lower().replace(' ', '')
                window_clean = window_name.lower().replace(' ', '')
                if owner == window_name or owner_clean == window_clean:
                    bounds = win.get('kCGWindowBounds', {})
                    width = bounds.get('Width', 0)
                    height = bounds.get('Height', 0)
                    area = width * height
                    # 选择最大的窗口（通常是主聊天窗口）
                    if area > best_area and area > 10000:  # 忽略太小的窗口
                        best_area = area
                        best_window = win.get('kCGWindowNumber')
            if best_window:
                return str(best_window)
        except Exception as e:
            print(f"Quartz error: {e}")
        return ""

    def capture_window(self, window_name: str = "微信") -> str:
        """截取指定窗口，返回图片文件路径"""
        _ensure_screenshots_dir()
        filename = os.path.join(SCREENSHOTS_DIR, f"window_{int(__import__('time').time() * 1000)}.png")

        window_id_str = self._get_window_id(window_name)
        if window_id_str:
            subprocess.run(
                ["screencapture", "-l", window_id_str, filename],
                capture_output=True, timeout=5
            )
        else:
            subprocess.run(
                ["screencapture", filename],
                capture_output=True, timeout=5
            )
        return filename

    def capture_region(self, x: int, y: int, w: int, h: int) -> str:
        """截取指定区域"""
        _ensure_screenshots_dir()
        filename = os.path.join(SCREENSHOTS_DIR, f"region_{int(__import__('time').time() * 1000)}.png")
        region = f"{x},{y},{w},{h}"
        subprocess.run(["screencapture", "-R", region, filename], capture_output=True, timeout=5)
        return filename

    def capture_full_screen(self) -> str:
        """全屏截图"""
        _ensure_screenshots_dir()
        filename = os.path.join(SCREENSHOTS_DIR, f"fullscreen_{int(__import__('time').time() * 1000)}.png")
        subprocess.run(["screencapture", filename], capture_output=True, timeout=5)
        return filename

    def load_image_as_base64(self, path: str) -> str:
        """将截图转为 base64"""
        import base64
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
