"""Einstellungen des Agenten. Electron schickt sie beim initialize."""

from __future__ import annotations

import getpass
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _default_data_dir() -> Path:
  base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
  return Path(base) / "Aura" / "agent"


@dataclass
class AgentSettings:
  model: str = "gemma4:26b"
  ollama_url: str = "http://127.0.0.1:11434"
  num_ctx: int = 16384
  keep_alive: str = "30m"
  language: str = "Deutsch"
  profile: str = ""
  user_name: str = field(default_factory=getpass.getuser)
  home: str = field(default_factory=lambda: str(Path.home()))
  platform: str = sys.platform
  session_type: str = field(default_factory=lambda: os.environ.get("XDG_SESSION_TYPE", ""))
  data_dir: Path = field(default_factory=_default_data_dir)
  aura_dir: Path = field(default_factory=lambda: Path.home() / ".aura")
  max_llm_calls: int = 60
  tool_policy: dict[str, str] = field(default_factory=dict)
  browser: bool = True  # Browser-Spezialist (Playwright-MCP)
  # Start des Playwright-MCP im Paket: [Electron, …/cli.js] mit ELECTRON_RUN_AS_NODE=1; leer = npx (Entwicklung)
  browser_command: list[str] = field(default_factory=list)
  browser_env: dict[str, str] = field(default_factory=dict)
  mcp_servers: list[dict[str, Any]] = field(default_factory=list)  # von Electron aufgelöst (Schlüssel eingesetzt)
  disabled_skills: list[str] = field(default_factory=list)
  browser_headless: bool = False
  apps: bool = True  # Spezialist für Desktop-Programme (AT-SPI)
  # Anbieter: "ollama" (lokal, Standard) oder "gemini" (Cloud, nur wenn der Nutzer es in den Einstellungen wählt).
  provider: str = "ollama"
  gemini_model: str = "gemini-3.8-flash"
  gemini_api_key: str = field(default="", repr=False)

  @classmethod
  def from_params(cls, p: dict[str, Any]) -> AgentSettings:
    s = cls()
    for key, attr in (
        ("model", "model"), ("ollamaUrl", "ollama_url"), ("numCtx", "num_ctx"), ("keepAlive", "keep_alive"),
        ("language", "language"), ("profile", "profile"), ("sessionType", "session_type"),
    ):
      if p.get(key) not in (None, ""):
        setattr(s, attr, type(getattr(s, attr))(p[key]))
    if p.get("dataDir"):
      s.data_dir = Path(p["dataDir"])
    if isinstance(p.get("toolPolicy"), dict):
      s.tool_policy = {str(k): str(v) for k, v in p["toolPolicy"].items()}
    if isinstance(p.get("browserCommand"), list):
      s.browser_command = [str(x) for x in p["browserCommand"]]
    if isinstance(p.get("browserEnv"), dict):
      s.browser_env = {str(k): str(v) for k, v in p["browserEnv"].items()}
    if isinstance(p.get("mcpServers"), list):
      s.mcp_servers = [x for x in p["mcpServers"] if isinstance(x, dict) and x.get("name")]
    if isinstance(p.get("disabledSkills"), list):
      s.disabled_skills = [str(x) for x in p["disabledSkills"]]
    if p.get("provider") in ("ollama", "gemini"):
      s.provider = p["provider"]
    if p.get("geminiModel"):
      s.gemini_model = str(p["geminiModel"])
    if p.get("geminiApiKey"):
      s.gemini_api_key = str(p["geminiApiKey"])
    if p.get("auraDir"):
      s.aura_dir = Path(p["auraDir"])
    return s

  def ensure_dirs(self) -> None:
    (self.data_dir / "audit").mkdir(parents=True, exist_ok=True)
