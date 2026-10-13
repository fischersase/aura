import asyncio
import json

from aura_agent.tools.desktop import list_windows, window_action


async def main():
    r = await list_windows()
    print("LIST", json.dumps(r, ensure_ascii=False))
    wid = r["windows"][0]["id"]
    for action in ("minimize", "focus", "maximize", "close"):
        out = await window_action(wid, action)
        print(action.upper(), out.get("verified"), out.get("error", ""))
    print("AFTER", (await list_windows())["count"])


asyncio.run(main())
