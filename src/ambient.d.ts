// Types for the `gi://` and `resource:///org/gnome/shell/...` modules GJS
// provides at runtime, plus GNOME Shell's globals (`global`, `logError`, ...).
// The prefs process has no Shell globals; prefs.ts doesn't use them.
import '@girs/gjs';
import '@girs/gjs/dom';
import '@girs/gjs/ambient';
import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';
import '@girs/adw-1/ambient';
import '@girs/gtk-4.0/ambient';
import '@girs/gdk-4.0/ambient';
