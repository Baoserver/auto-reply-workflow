"""本地 OCR 模块 — 调用预编译 Swift Vision OCR 二进制"""

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

SWIFT_OCR_BIN = Path(__file__).parent / "vision_ocr"


@dataclass
class OCRLine:
    text: str
    x: float
    y: float
    width: float
    height: float


class LocalOCR:
    """macOS Vision 本地 OCR，调用预编译 Swift 二进制，延迟约 50ms，免费。"""

    def __init__(self, config: dict):
        ocr_cfg = config.get("ocr", {})
        self.langs = ocr_cfg.get("languages", ["zh-Hans", "en"])
        self.fast_mode = ocr_cfg.get("fast_mode", True)
        self.enabled = SWIFT_OCR_BIN.exists()
        if not self.enabled:
            print(f"[LocalOCR] Warning: {SWIFT_OCR_BIN} not found, OCR disabled")

    def extract_text(self, image_path: str) -> list[OCRLine]:
        """从截图提取全部文字行，返回 OCRLine 列表。"""
        if not self.enabled:
            return []
        try:
            result = subprocess.run(
                [str(SWIFT_OCR_BIN), image_path],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                return []

            data = json.loads(result.stdout.strip())
            lines: list[OCRLine] = []
            for item in data:
                text = item.get("text", "").strip()
                if not text:
                    continue
                lines.append(OCRLine(
                    text=text,
                    x=item.get("x", 0),
                    y=item.get("y", 0),
                    width=item.get("width", 0),
                    height=item.get("height", 0),
                ))
            return lines
        except Exception as e:
            print(f"[LocalOCR] Error: {e}")
            return []

    def extract_text_string(self, image_path: str) -> str:
        """提取全部文字，合并为单个字符串（用于快速 diff）。"""
        lines = self.extract_text(image_path)
        return "\n".join(line.text for line in lines)

    def extract_chat_region(self, image_path: str, region: tuple = None) -> list[OCRLine]:
        """
        提取聊天区域的文字。region = (x1, y1, x2, y2) 归一化坐标。
        如果 region 为 None，返回全部文字。
        """
        all_lines = self.extract_text(image_path)
        if region is None or not all_lines:
            return all_lines

        x1, y1, x2, y2 = region
        filtered = []
        for line in all_lines:
            cx = line.x + line.width / 2
            cy = line.y + line.height / 2
            if x1 <= cx <= x2 and y1 <= cy <= y2:
                filtered.append(line)
        return filtered
