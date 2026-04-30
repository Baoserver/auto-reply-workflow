"""macOS 截屏模块 — 捕获微信/企微窗口"""

import subprocess
import os
from pathlib import Path
from Quartz import CGWindowListCopyWindowInfo, CGWindowListCreateImage, kCGNullWindowID, kCGWindowListOptionAll, kCGWindowListExcludeDesktopElements

SCREENSHOTS_DIR = os.path.expanduser("/tmp/screenshots")
MAX_SCREENSHOT_FILES = 30

def _ensure_screenshots_dir():
    Path(SCREENSHOTS_DIR).mkdir(parents=True, exist_ok=True)

def cleanup_screenshots_dir(max_files: int = MAX_SCREENSHOT_FILES):
    """只保留截图目录中最新的 max_files 个图片文件。"""
    _ensure_screenshots_dir()
    try:
        files = []
        for name in os.listdir(SCREENSHOTS_DIR):
            path = os.path.join(SCREENSHOTS_DIR, name)
            if not os.path.isfile(path):
                continue
            if not name.lower().endswith((".png", ".jpg", ".jpeg")):
                continue
            files.append((os.path.getmtime(path), path))

        files.sort(reverse=True)
        for _, path in files[max_files:]:
            try:
                os.unlink(path)
            except OSError:
                pass
    except Exception as e:
        print(f"cleanup screenshots error: {e}")

class ScreenCapture:
    def _find_window(self, window_name: str):
        """通过 Quartz 找到指定应用最大的主窗口。"""
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
                        best_window = win
            return best_window
        except Exception as e:
            print(f"Quartz error: {e}")
        return None

    def _get_window_id(self, window_name: str) -> str:
        """通过 Quartz 获取窗口 ID，选择最大的窗口"""
        best_window = self._find_window(window_name)
        if best_window:
            return str(best_window.get('kCGWindowNumber'))
        return ""

    def get_window_bounds(self, window_name: str) -> dict | None:
        """获取指定窗口坐标和尺寸，用于窗口内相对点击。"""
        best_window = self._find_window(window_name)
        if not best_window:
            return None
        bounds = best_window.get('kCGWindowBounds', {})
        try:
            return {
                "x": int(bounds.get('X', 0)),
                "y": int(bounds.get('Y', 0)),
                "width": int(bounds.get('Width', 0)),
                "height": int(bounds.get('Height', 0)),
            }
        except Exception:
            return None

    def capture_window(self, window_name: str = "微信") -> str:
        """截取指定窗口，返回图片文件路径"""
        _ensure_screenshots_dir()
        cleanup_screenshots_dir()
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
        cleanup_screenshots_dir()
        return filename

    def capture_region(self, x: int, y: int, w: int, h: int) -> str:
        """截取指定区域"""
        _ensure_screenshots_dir()
        cleanup_screenshots_dir()
        filename = os.path.join(SCREENSHOTS_DIR, f"region_{int(__import__('time').time() * 1000)}.png")
        region = f"{x},{y},{w},{h}"
        subprocess.run(["screencapture", "-R", region, filename], capture_output=True, timeout=5)
        cleanup_screenshots_dir()
        return filename

    def capture_full_screen(self) -> str:
        """全屏截图"""
        _ensure_screenshots_dir()
        cleanup_screenshots_dir()
        filename = os.path.join(SCREENSHOTS_DIR, f"fullscreen_{int(__import__('time').time() * 1000)}.png")
        subprocess.run(["screencapture", filename], capture_output=True, timeout=5)
        cleanup_screenshots_dir()
        return filename

    def load_image_as_base64(self, path: str) -> str:
        """将截图转为 base64"""
        import base64
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("utf-8")
