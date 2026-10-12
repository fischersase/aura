// Aura Bridge: Fenster unter GNOME Wayland für den Aura-Agenten (D-Bus org.aura.Bridge auf dem Session-Bus).
// Unter Wayland dürfen Programme keine fremden Fenster sehen oder steuern; GNOMEs eigene Schnittstelle
// (org.gnome.Shell.Introspect) ist ohne „unsafe mode“ gesperrt. Diese Erweiterung bietet genau die fünf
// Funktionen, die Aura braucht, und nichts weiter (kein Lesen von Fensterinhalten, keine Eingaben).
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `
<node>
  <interface name="org.aura.Bridge">
    <method name="ListWindows"><arg type="s" direction="out" name="json"/></method>
    <method name="Activate"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Minimize"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Maximize"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <method name="Close"><arg type="t" direction="in" name="id"/><arg type="b" direction="out" name="ok"/></method>
    <property name="Version" type="u" access="read"/>
  </interface>
</node>`;

export default class AuraBridge extends Extension {
  enable() {
    this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
    this._dbus.export(Gio.DBus.session, '/org/aura/Bridge');
    this._owner = Gio.bus_own_name(Gio.BusType.SESSION, 'org.aura.Bridge', Gio.BusNameOwnerFlags.NONE, null, null, null);
  }

  disable() {
    if (this._dbus) this._dbus.unexport();
    if (this._owner) Gio.bus_unown_name(this._owner);
    this._dbus = null;
    this._owner = 0;
  }

  get Version() {
    return 1;
  }

  _windows() {
    return global.get_window_actors()
      .map((a) => a.meta_window)
      .filter((w) => w && !w.is_skip_taskbar() && w.get_window_type() === Meta.WindowType.NORMAL);
  }

  _find(id) {
    return this._windows().find((w) => w.get_id() === Number(id)) || null;
  }

  ListWindows() {
    const focus = global.display.get_focus_window();
    return JSON.stringify(this._windows().map((w) => ({
      id: w.get_id(),
      title: w.get_title() || '',
      app: w.get_wm_class() || '',
      instance: w.get_wm_class_instance() || '',
      pid: w.get_pid(),
      active: w === focus,
      minimized: w.minimized,
    })));
  }

  Activate(id) {
    const w = this._find(id);
    if (!w) return false;
    w.activate(global.get_current_time());
    return true;
  }

  Minimize(id) {
    const w = this._find(id);
    if (!w) return false;
    w.minimize();
    return true;
  }

  Maximize(id) {
    const w = this._find(id);
    if (!w) return false;
    if (w.minimized) w.unminimize();
    w.maximize(Meta.MaximizeFlags.BOTH);
    return true;
  }

  Close(id) {
    const w = this._find(id);
    if (!w) return false;
    w.delete(global.get_current_time());
    return true;
  }
}
