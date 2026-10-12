"""Selbsttest des (gebündelten) Agenten, ohne Modell und ohne Electron.

Läuft in der Release-Pipeline nach dem Bündeln: Importe, Werkzeuge, Hülle,
Sitzungsdatenbank und Audit-Kette müssen im fertigen Paket funktionieren.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path


async def run() -> int:
  from .harness.audit import AuditLog
  from .runtime.controller import TaskController
  from .runtime.server import build_runner
  from .runtime.settings import AgentSettings
  from .testing.fake_host import FakeHost
  from .testing.scripted_llm import Call, ScriptedLlm

  with tempfile.TemporaryDirectory() as tmp:
    settings = AgentSettings(data_dir=Path(tmp) / "agent", aura_dir=Path(tmp) / "aura")
    llm = ScriptedLlm([
        [Call("system_info", {}), Call("list_dir", {"path": tmp})],
        [Call("run_command", {"command": f"rm {tmp}/gibt-es-nicht"})],
        [Call("run_command", {"command": "cat ~/.ssh/id_rsa"})],
        "Selbsttest fertig.",
    ])
    host = FakeHost(["deny"])
    ctl = TaskController(build_runner(settings, llm), host, AuditLog(settings.data_dir / "audit"), settings.home)
    ctl.start("t1", "selftest", "Selbsttest")
    while ctl.tasks:
      await asyncio.sleep(0.02)
    done = host.done()
    steps = [(p["tool"], p["state"]) for p in host.of("task.step")]
    audit = next((settings.data_dir / "audit").glob("*.jsonl"))
    chain_ok, lines = AuditLog.verify(audit)
    checks = {
        "Auftrag abgeschlossen": bool(done) and done["text"] == "Selbsttest fertig.",
        "lesende Werkzeuge liefen": ("system_info", "ok") in steps and ("list_dir", "ok") in steps,
        "ändernder Befehl wurde gefragt (T2)": len(host.approvals) == 1 and "rm " in host.approvals[0]["label"],
        "Ablehnung wurde respektiert": steps.count(("run_command", "denied")) == 2 and ("run_command", "run") not in steps,
        "Zugangsdaten gesperrt ohne Rückfrage (T3)": all("ssh" not in a["label"] for a in host.approvals),
        "Audit-Kette intakt": chain_ok and lines >= 5,
    }
  for name, ok in checks.items():
    print(f"{'ok ' if ok else 'FEHLER'} {name}", file=sys.stderr)
  return 0 if all(checks.values()) else 1
