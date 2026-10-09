import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INTERFACE = `
<node>
  <interface name="app.mynudge.FocusProbe">
    <method name="FocusedApp">
      <arg type="s" direction="out" name="app"/>
    </method>
  </interface>
</node>`;

export default class FocusProbe extends Extension {
    enable() {
        this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        this._exported.export(Gio.DBus.session, '/app/mynudge/FocusProbe');
    }

    disable() {
        this._exported.unexport();
        this._exported = null;
    }

    FocusedApp() {
        const focused = global.display.focus_window;
        return focused ? (focused.get_wm_class() ?? '') : '';
    }
}
