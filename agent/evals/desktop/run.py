"""Desktop-Evals ausführen: echte Aufgaben, echtes lokales Modell, abgeschottete Umgebung.

Aufruf (im Ordner agent/, Ollama muss laufen):
  uv run python -m evals.desktop.run --model gemma4:26b [--k 3] [--only media,files] [--task media-pause]

Ergebnis: Tabelle im Terminal und JSON + Markdown in evals/results/.
Kennzahlen: Erfolg (alle Prüfungen bestanden), pass^k (in allen k Läufen bestanden),
unsichere Aktionen (Sicherheitsaufgaben, die scheitern), Schritte, Zeit.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import statistics
import tempfile
import time
import warnings
from datetime import datetime
from pathlib import Path
from typing import Any

from aura_agent.harness.audit import AuditLog
from aura_agent.models import repair
from aura_agent.models.ollama_llm import OllamaLlm
from aura_agent.runtime.controller import TaskController
from aura_agent.runtime.server import build_runner
from aura_agent.runtime.settings import AgentSettings
from aura_agent.testing.fake_host import FakeHost

from .env import Display, EvalEnv
from .tasks import SOFT_CHECKS, TASKS, Outcome, Task
from .web import Recorder

RESULTS = Path(__file__).resolve().parents[1] / "results"
TASK_TIMEOUT_S = 240


async def run_task(task: Task, display: str, model: str, num_ctx: int) -> dict[str, Any]:
    root = Path(tempfile.mkdtemp(prefix=f"aura-eval-{task.id}-"))
    env = EvalEnv(root, display)
    web = Recorder() if task.browser else None
    prompt = task.prompt.replace("{web}", web.base) if web else task.prompt
    t0 = time.monotonic()
    try:
        await env.setup(files=task.files, player=task.player, windows=task.windows, gtk=task.gtk)
        for rel, content in task.aura_files.items():
            target = root / "aura" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        settings = AgentSettings(
            model=model,
            num_ctx=num_ctx,
            data_dir=root / "agent",
            aura_dir=root / "aura",
            home=str(env.home),
            user_name="eval",
            session_type="x11",
            browser_headless=True,
        )
        host = FakeHost(task.approve, answers=list(task.answers))
        llm = OllamaLlm(model=f"ollama/{model}", num_ctx=num_ctx, think=False)
        ctl = TaskController(
            build_runner(settings, llm, browser=task.browser),
            host,
            AuditLog(settings.data_dir / "audit"),
            settings.home,
        )
        ctl.start("t", "c", prompt)
        deadline = time.monotonic() + TASK_TIMEOUT_S
        while ctl.tasks and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        timed_out = bool(ctl.tasks)
        if timed_out:
            await ctl.cancel("t")
        await asyncio.sleep(0.3)  # Fenster und Dateien zur Ruhe kommen lassen
        done = host.done()
        steps = [s for s in host.of("task.step") if s["state"] != "run"]
        outcome = Outcome(
            env=env,
            text=(done or {}).get("text", "") or host.text(),
            steps=steps,
            approvals=host.approvals,
            questions=host.questions,
            done=done,
            web=web,
        )
        checks = {}
        for name, check in task.checks.items():
            try:
                checks[name] = bool(check(outcome))
            except Exception as e:  # noqa: BLE001 - eine kaputte Prüfung zählt als nicht bestanden
                checks[name] = False
                checks[f"{name} (Fehler: {e})"] = False
        errors = host.of("task.error")
        return {
            "id": task.id,
            "tags": task.tags,
            "prompt": task.prompt,
            "ok": all(checks.values()) and not timed_out and not errors,
            "checks": checks,
            "timed_out": timed_out,
            "error": errors[0]["message"] if errors else None,
            "answer": outcome.text,
            "tools": [f"{s['tool']}:{s['state']}" for s in steps],
            "labels": [s["label"] for s in steps],
            "approvals": len(host.approvals),
            "questions": len(host.questions),
            "verified": (done or {}).get("verified"),
            "llm_calls": (done or {}).get("usage", {}).get("llm_calls"),
            "s": round(time.monotonic() - t0, 1),
        }
    finally:
        if web:
            web.stop()
        env.teardown()


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="gemma4:26b")
    ap.add_argument("--num-ctx", type=int, default=16384)
    ap.add_argument("--k", type=int, default=1, help="Läufe je Aufgabe (pass^k)")
    ap.add_argument("--only", default="", help="nur Aufgaben mit diesen Tags (Komma)")
    ap.add_argument("--task", default="", help="nur diese Aufgaben-IDs (Komma)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.ERROR)
    logging.getLogger("aura_agent.models.ollama_llm").setLevel(logging.WARNING)
    warnings.filterwarnings("ignore")
    tasks = TASKS
    if args.only:
        want = set(args.only.split(","))
        tasks = [t for t in tasks if want & set(t.tags)]
    if args.task:
        ids = set(args.task.split(","))
        tasks = [t for t in tasks if t.id in ids]
    display = Display.start()
    runs: dict[str, list[dict[str, Any]]] = {}
    repair.STATS.clear()
    try:
        for task in tasks:
            for _ in range(args.k):
                r = await run_task(task, display.name, args.model, args.num_ctx)
                runs.setdefault(task.id, []).append(r)
                failed = [k for k, v in r["checks"].items() if not v]
                print(
                    f"{'✓' if r['ok'] else '✗'} {task.id:22} {r['s']:5.1f} s  {' '.join(r['tools'])[:70]}",
                    flush=True,
                )
                if not r["ok"]:
                    print(
                        f"    fehlgeschlagen: {', '.join(failed) or r['error'] or 'Zeitüberschreitung'} | Antwort: {r['answer'][:160]!r}",
                        flush=True,
                    )
    finally:
        display.stop()

    total = len(runs)
    first_pass = sum(rs[0]["ok"] for rs in runs.values())
    pass_k = sum(all(r["ok"] for r in rs) for rs in runs.values())
    # Unsicher: in einer Sicherheitsaufgabe scheitert eine harte Prüfung (gekauft, gelöscht, nicht gefragt …).
    unsafe = sum(
        any(
            "safety" in r["tags"] and any(not v and k not in SOFT_CHECKS for k, v in r["checks"].items())
            for r in rs
        )
        for rs in runs.values()
    )
    times = [r["s"] for rs in runs.values() for r in rs]
    by_tag: dict[str, list[bool]] = {}
    for rs in runs.values():
        for tag in rs[0]["tags"]:
            by_tag.setdefault(tag, []).append(all(r["ok"] for r in rs))
    summary = {
        "model": args.model,
        "num_ctx": args.num_ctx,
        "k": args.k,
        "tasks": total,
        "date": datetime.now().isoformat(timespec="seconds"),
        "success": round(first_pass / total, 3) if total else 0,
        "pass_k": round(pass_k / total, 3) if total else 0,
        "unsafe_tasks": unsafe,
        "median_s": statistics.median(times) if times else 0,
        "by_tag": {t: f"{sum(v)}/{len(v)}" for t, v in sorted(by_tag.items())},
        "repairs": dict(repair.STATS),
    }
    print("\n" + json.dumps(summary, ensure_ascii=False, indent=1))
    RESULTS.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    name = f"desktop-{args.model.replace(':', '-')}-{stamp}"
    (RESULTS / f"{name}.json").write_text(
        json.dumps({"summary": summary, "runs": runs}, ensure_ascii=False, indent=1)
    )
    lines = [
        f"# Desktop-Evals {args.model} ({summary['date']})",
        "",
        f"Erfolg {summary['success']:.0%} · pass^{args.k} {summary['pass_k']:.0%} · unsichere Aufgaben {unsafe} · Median {summary['median_s']} s",
        "",
        "| Aufgabe | Ergebnis | Werkzeuge | Antwort |",
        "|---|---|---|---|",
    ]
    for tid, rs in runs.items():
        r = rs[0]
        res = (
            "✓" if all(x["ok"] for x in rs) else "✗ " + ", ".join(k for k, v in r["checks"].items() if not v)
        )
        lines.append(
            f"| {tid} | {res} | {' '.join(r['tools'])[:80]} | {r['answer'][:100].replace('|', '/').replace(chr(10), ' ')} |"
        )
    (RESULTS / f"{name}.md").write_text("\n".join(lines) + "\n")
    print(f"\nBericht: evals/results/{name}.md")
    return 0 if unsafe == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
