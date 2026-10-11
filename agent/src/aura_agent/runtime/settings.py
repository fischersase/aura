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
    if p.get("auraDir"):
      s.aura_dir = Path(p["auraDir"])
    return s

  def ensure_dirs(self) -> None:
    (self.data_dir / "audit").mkdir(parents=True, exist_ok=True)
