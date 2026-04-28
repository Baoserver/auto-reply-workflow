"""OpenClaw 回复工作流客户端。"""

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Any


DEFAULT_CLI_PATH = "/opt/homebrew/bin/openclaw"


def emit_log(level: str, message: str):
    print(json.dumps({"type": "log", "data": {"level": level, "message": message}}, ensure_ascii=False), flush=True)


def emit(event_type: str, data: dict):
    print(json.dumps({"type": event_type, "data": data}, ensure_ascii=False), flush=True)


@dataclass
class OpenClawRoute:
    agent_id: str
    agent_name: str
    matched_keyword: str
    extra_prompt: str = ""


class OpenClawClient:
    def __init__(self, config: dict, mode: str = "customer"):
        self.mode = mode if mode in {"customer", "assistant"} else "customer"
        cfg = self._resolve_config(config, self.mode)
        self.enabled = bool(cfg.get("enabled", False))
        self.cli_path = cfg.get("cli_path") or DEFAULT_CLI_PATH
        self.timeout_seconds = int(cfg.get("timeout_seconds") or 120)
        self.extra_prompt = cfg.get("extra_prompt", "") or ""
        self.routes = cfg.get("routes", []) or []

    def _resolve_config(self, config: dict, mode: str) -> dict:
        raw = config.get("openclaw", {}) or {}
        if not isinstance(raw, dict):
            return {}

        mode_cfg = raw.get(mode)
        if isinstance(mode_cfg, dict):
            return mode_cfg

        # Backward compatibility: old versions stored one flat openclaw block.
        legacy_keys = {"enabled", "cli_path", "timeout_seconds", "extra_prompt", "routes"}
        if any(key in raw for key in legacy_keys):
            return raw

        return {}

    def match_route(self, message: str) -> OpenClawRoute | None:
        """按配置顺序查找第一条命中的启用路由。"""
        if not self.enabled:
            return None

        for route in self.routes:
            if not route or not route.get("enabled", True):
                continue

            agent_id = (route.get("agent_id") or "").strip()
            if not agent_id:
                continue

            keywords = self._normalize_keywords(route.get("keywords"))
            for keyword in keywords:
                if keyword and keyword in message:
                    return OpenClawRoute(
                        agent_id=agent_id,
                        agent_name=(route.get("agent_name") or agent_id).strip(),
                        matched_keyword=keyword,
                        extra_prompt=(route.get("extra_prompt") or "").strip(),
                    )
        return None

    def generate_reply(self, message: str, channel: str, sender: str, context: str = "") -> str | None:
        route = self.match_route(message)
        if not route:
            return None

        prompt = self._build_prompt(
            message=message,
            channel=channel,
            sender=sender,
            route=route,
            context=context,
        )
        emit_log("info", f"OpenClaw route matched: agent={route.agent_id}, keyword={route.matched_keyword}")
        call_result = self._call_agent(route=route, prompt=prompt)
        if not call_result:
            return None
        if not call_result.get("reply"):
            emit_log("warn", "OpenClaw empty or unparseable reply")
            return None
        return call_result["reply"]

    def run_agent(self, route: OpenClawRoute, message: str, channel: str, sender: str, context: str = "") -> str | None:
        """直接调用已命中的 OpenClaw route，不再重复做关键词匹配。"""
        if not self.enabled:
            emit_log("warn", "OpenClaw disabled, assistant workflow skipped")
            return None

        prompt = self._build_prompt(
            message=message,
            channel=channel,
            sender=sender,
            route=route,
            context=context,
        )
        emit_log("info", f"OpenClaw assistant route matched: agent={route.agent_id}, keyword={route.matched_keyword}")
        call_result = self._call_agent(route=route, prompt=prompt)
        if not call_result:
            return None
        if not call_result.get("reply"):
            emit_log("warn", "OpenClaw empty or unparseable reply")
            return None
        return call_result["reply"]

    def run_agent_detail(self, route: OpenClawRoute, message: str, channel: str, sender: str, context: str = "") -> dict | None:
        """直接调用已命中的 OpenClaw route，并返回完整调用信息供前端日志展示。"""
        if not self.enabled:
            emit_log("warn", "OpenClaw disabled, assistant workflow skipped")
            return None

        prompt = self._build_prompt(
            message=message,
            channel=channel,
            sender=sender,
            route=route,
            context=context,
        )
        emit_log("info", f"OpenClaw route matched: agent={route.agent_id}, keyword={route.matched_keyword}")
        return self._call_agent(route=route, prompt=prompt)

    def _call_agent(self, route: OpenClawRoute, prompt: str) -> dict | None:
        cmd = [
            self.cli_path,
            "agent",
            "--agent",
            route.agent_id,
            "--message",
            prompt,
            "--json",
            "--timeout",
            str(self.timeout_seconds),
        ]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds + 10,
            )
        except FileNotFoundError:
            emit_log("error", f"OpenClaw CLI not found: {self.cli_path}")
            return None
        except subprocess.TimeoutExpired:
            emit_log("error", f"OpenClaw timeout after {self.timeout_seconds}s")
            return None
        except Exception as e:
            emit_log("error", f"OpenClaw error: {e}")
            return None

        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").strip()
            emit_log("error", f"OpenClaw non-zero exit {result.returncode}: {err[:500]}")
            return None

        parsed = self._parse_json_output(result.stdout.strip())
        reply = self._extract_reply(result.stdout, parsed)
        call_result = {
            "reply": reply,
            "agent_id": route.agent_id,
            "agent_name": route.agent_name,
            "matched_keyword": route.matched_keyword,
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
            "parsed": parsed,
        }
        emit("openclaw", call_result)
        return call_result

    def _build_prompt(self, message: str, channel: str, sender: str, route: OpenClawRoute, context: str = "") -> str:
        parts = [
            "你正在作为客服回复工作流中的 OpenClaw Agent。",
            "请只输出一段可以直接发送给客户的简体中文回复，不要输出分析过程、Markdown 标题、JSON 或代码块。",
            "",
            f"渠道：{channel}",
            f"发送者：{sender}",
            f"客户消息：{message}",
            f"命中关键词：{route.matched_keyword}",
            f"路由 Agent：{route.agent_name} ({route.agent_id})",
        ]
        if context.strip():
            parts.extend(["", "识别出的对话信息：", context.strip()])
        effective_prompt = route.extra_prompt or self.extra_prompt
        if effective_prompt.strip():
            parts.extend(["", "额外设定：", effective_prompt.strip()])
        return "\n".join(parts)

    def _extract_reply(self, output: str, parsed: Any | None = None) -> str | None:
        raw = output.strip()
        if not raw:
            return None

        if parsed is not None:
            text = self._find_text(parsed)
            if text:
                return self._clean_reply(text)

        return self._clean_reply(raw)

    def _parse_json_output(self, raw: str) -> Any | None:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass

        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end + 1])
            except json.JSONDecodeError:
                return None
        return None

    def _find_text(self, value: Any) -> str | None:
        candidates = self._collect_text_candidates(value)
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0], reverse=True)
        return candidates[0][1]

    def _collect_text_candidates(self, value: Any, path: tuple[str, ...] = ()) -> list[tuple[int, str]]:
        if isinstance(value, str):
            text = value.strip()
            if not self._is_reply_candidate(text, path):
                return []
            key = path[-1].lower() if path else ""
            score = min(len(text), 1000)
            if key in {"reply", "final_reply", "final_answer", "final_response", "answer"}:
                score += 2000
            elif key in {"content", "text", "message", "response", "output", "result", "summary"}:
                score += 1000
            if re.search(r"[\u4e00-\u9fff]", text):
                score += 200
            return [(score, text)]
        if isinstance(value, list):
            candidates: list[tuple[int, str]] = []
            for item in value:
                candidates.extend(self._collect_text_candidates(item, path))
            return candidates
        if not isinstance(value, dict):
            return []

        preferred_keys = (
            "reply",
            "final_reply",
            "final_answer",
            "final_response",
            "answer",
            "content",
            "text",
            "message",
            "response",
            "output",
            "summary",
        )
        candidates: list[tuple[int, str]] = []
        for key in preferred_keys:
            if key in value:
                candidates.extend(self._collect_text_candidates(value.get(key), (*path, key)))

        ignored_keys = {
            "status", "state", "id", "uid", "uuid", "type", "role", "name",
            "agent", "agent_id", "agent_name", "model", "provider", "created_at",
            "updated_at", "timestamp", "duration", "elapsed", "success",
        }
        for key, item in value.items():
            if key in preferred_keys or key.lower() in ignored_keys:
                continue
            candidates.extend(self._collect_text_candidates(item, (*path, key)))
        return candidates

    def _is_reply_candidate(self, text: str, path: tuple[str, ...]) -> bool:
        if not text:
            return False
        key = path[-1].lower() if path else ""
        if key in {"status", "state", "id", "type", "role", "name", "agent", "agent_id", "model"}:
            return False
        if text.lower() in {"completed", "complete", "success", "ok", "done", "running", "failed", "error"}:
            return False
        if len(text) < 2:
            return False
        return True

    def _clean_reply(self, text: str) -> str | None:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`").strip()
        return cleaned or None

    def _normalize_keywords(self, value: Any) -> list[str]:
        if isinstance(value, list):
            raw_items = value
        elif isinstance(value, str):
            raw_items = value.replace("，", ",").split(",")
        else:
            raw_items = []
        return [str(item).strip() for item in raw_items if str(item).strip()]
