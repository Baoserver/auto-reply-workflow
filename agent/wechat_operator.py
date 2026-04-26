"""键鼠模拟操作模块 — 模拟点击、输入、发送"""

import time
import subprocess
import pyautogui


pyautogui.PAUSE = 0.3
pyautogui.FAILSAFE = True


class WeChatOperator:
    def __init__(self):
        self._last_input_box_pos = None

    def update_input_box_position(self, x: int, y: int):
        """更新输入框坐标（由 vision 分析后调用）"""
        self._last_input_box_pos = (x, y)

    def type_and_send(self, text: str, window_name: str = None):
        """使用 AppleScript 直接发送消息，更可靠"""
        print(f"[WeChatOperator] type_and_send called: window_name={window_name}, text={text[:20]}...")

        if not window_name:
            # 如果没有 window_name，尝试使用 pyautogui 方式
            if self._last_input_box_pos:
                x, y = self._last_input_box_pos
                pyautogui.click(x, y)
                time.sleep(0.3)
                self._paste_text(text)
                time.sleep(0.3)
                self._press_enter()
            return

        # 先设置剪贴板
        subprocess.run(["pbcopy"], input=text.encode("utf-8"))

        # AppleScript 激活窗口并发送
        script = f'''
        tell application "{window_name}"
            activate
        end tell
        delay 1.0

        tell application "System Events"
            keystroke "v" using command down
            delay 0.5
            keystroke return
        end tell
        '''
        print(f"[WeChatOperator] Running AppleScript for {window_name}")
        result = subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)
        print(f"[WeChatOperator] AppleScript result: returncode={result.returncode}, stdout={result.stdout}, stderr={result.stderr}")
        if result.returncode != 0:
            print(f"[WeChatOperator] AppleScript failed for window_name={window_name}")

    def _paste_text(self, text: str):
        """通过剪贴板粘贴文本（比逐字输入快且支持中文）"""
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        script = f'''
        set the clipboard to "{escaped}"
        delay 0.1
        tell application "System Events" to keystroke "v" using command down
        '''
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)

    def _press_enter(self):
        """模拟回车发送"""
        pyautogui.press("return")

    def click_at(self, x: int, y: int):
        """点击指定坐标"""
        pyautogui.click(x, y)

    def bring_window_to_front(self, window_name: str):
        """将指定窗口置于前台"""
        script = f'''
        tell application "{window_name}"
            activate
        end tell
        '''
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
