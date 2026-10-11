"""Ein minimales X11-Fenster für Tests (WM_CLASS aura-testwin), bleibt offen bis es geschlossen wird."""

import os
import sys

from Xlib import X, Xatom, display

d = display.Display()
s = d.screen()
w = s.root.create_window(10, 10, 300, 200, 0, s.root_depth, X.InputOutput, X.CopyFromParent,
                         background_pixel=s.white_pixel, event_mask=X.StructureNotifyMask)
w.set_wm_class("aura-testwin", "AuraTestwin")
w.set_wm_name(sys.argv[1] if len(sys.argv) > 1 else "Aura Testfenster")
w.change_property(d.intern_atom("_NET_WM_PID"), Xatom.CARDINAL, 32, [os.getpid()])
w.map()
d.flush()
while True:
  ev = d.next_event()
  if ev.type == X.DestroyNotify:
    break
