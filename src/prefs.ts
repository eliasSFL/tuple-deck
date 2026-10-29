import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {TupleCli, findProgram} from './lib/cli.js';
import {type Shortcut, SHORTCUTS, parseSettings} from './lib/model.js';

// Friendlier labels for Tuple's own settings; unknown ones fall back to the CLI's text.
const TUPLE_SETTING_LABELS: Record<string, [string, string]> = {
    'overlay': ['Annotation overlay', 'Show the annotation window while sharing your screen'],
    'start-calls-muted': ['Start calls muted', 'Join every call with the microphone off'],
    'capture': ['Screen capture method', 'Use “portal” on Wayland'],
    'guest-mode': ['Shared-screen mode', 'Annotate on, or take control of, a screen someone shares'],
    'transcription-model': ['Transcription model', 'Path to a whisper ggml model used for call capture'],
};

/**
 * Asks for a key combination. Resolves with its accelerator string, '' when
 * the user pressed Backspace to remove the shortcut, or null when cancelled.
 */
function captureShortcut(parent: Gtk.Widget, title: string): Promise<string | null> {
    return new Promise(resolve => {
        let result: string | null = null;
        const dialog = new Adw.Dialog({title, content_width: 380});
        const view = new Adw.ToolbarView({content: new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: 'Press the new shortcut',
            description: 'Esc cancels, Backspace removes the shortcut.',
        })});
        view.add_top_bar(new Adw.HeaderBar());
        dialog.child = view;

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            const key = Gdk.keyval_to_lower(keyval);
            if (!mods && key === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && key === Gdk.KEY_BackSpace) {
                result = '';
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Bare keys would swallow normal typing; only function and media
            // keys may go without a modifier.
            const bareOk = (key >= Gdk.KEY_F1 && key <= Gdk.KEY_F35) || key >= 0x1008ff00;
            if (!Gtk.accelerator_valid(key, mods) || (!mods && !bareOk))
                return Gdk.EVENT_STOP;
            result = Gtk.accelerator_name_with_keycode(null, key, keycode, mods);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.connect('closed', () => resolve(result));
        dialog.present(parent);
    });
}

function shortcutRow(settings: Gio.Settings, {key, title, subtitle}: Shortcut): Adw.ActionRow {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    const label = new Adw.ShortcutLabel({valign: Gtk.Align.CENTER, disabled_text: 'Disabled'});
    const clear = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Remove shortcut',
        css_classes: ['flat'],
    });
    row.add_suffix(label);
    row.add_suffix(clear);
    const sync = () => {
        const accel = settings.get_strv(key)[0] ?? '';
        label.accelerator = accel;
        clear.sensitive = !!accel;
    };
    settings.connect(`changed::${key}`, sync);
    sync();
    clear.connect('clicked', () => settings.set_strv(key, []));
    row.connect('activated', async () => {
        const accel = await captureShortcut(row, title);
        if (accel !== null)
            settings.set_strv(key, accel ? [accel] : []);
    });
    return row;
}

export default class TupleDeckPreferences extends ExtensionPreferences {
    override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const cli = new TupleCli(() => settings.get_string('tuple-path'));
        window.set_default_size(640, 720);

        const tuplePage = new Adw.PreferencesPage({title: 'Tuple', icon_name: 'call-start-symbolic'});
        window.add(tuplePage);
        const extensionPage = new Adw.PreferencesPage({title: 'Extension', icon_name: 'preferences-system-symbolic'});
        window.add(extensionPage);

        this._fillExtensionPage(extensionPage, settings, cli);
        await this._fillTuplePage(tuplePage, cli);
    }

    private async _fillTuplePage(page: Adw.PreferencesPage, cli: TupleCli) {
        const group = new Adw.PreferencesGroup({
            title: 'Tuple settings',
            description: 'Stored by the Tuple app itself (tuple settings / tuple set).',
        });
        page.add(group);

        const result = await cli.run(['settings'], {json: false, timeout: 10});
        const items = result.ok ? parseSettings(result.stdout) : [];
        if (!items.length) {
            group.add(new Adw.ActionRow({
                title: "Couldn't read Tuple's settings",
                subtitle: result.error || 'Is Tuple running and logged in?',
            }));
        }

        const apply = async (name: string, value: string | number, row: Adw.PreferencesRow) => {
            const r = await cli.run(['set', name, String(value)], {json: false, timeout: 10});
            row.remove_css_class('error');
            if (!r.ok) {
                row.add_css_class('error');
                row.set_tooltip_text(r.error);
            }
        };

        for (const item of items) {
            const [title, subtitle] = TUPLE_SETTING_LABELS[item.name] ?? [item.name, item.description];
            if (item.kind === 'bool') {
                const row = new Adw.SwitchRow({title, subtitle, active: item.value === '1'});
                row.connect('notify::active', () => apply(item.name, row.active ? 1 : 0, row));
                group.add(row);
            } else if (item.kind === 'choice' && item.options) {
                const options = item.options;
                const row = new Adw.ComboRow({
                    title,
                    subtitle,
                    model: Gtk.StringList.new(options),
                    selected: Math.max(0, options.indexOf(item.value)),
                });
                row.connect('notify::selected', () => apply(item.name, options[row.selected], row));
                group.add(row);
            } else {
                const row = new Adw.EntryRow({title, text: item.value, show_apply_button: true});
                row.set_tooltip_text(subtitle);
                row.connect('apply', () => apply(item.name, row.text, row));
                group.add(row);
            }
        }

        const about = new Adw.PreferencesGroup({title: 'About'});
        page.add(about);
        const version = await cli.run(['version'], {json: false, timeout: 10});
        about.add(new Adw.ActionRow({
            title: 'Tuple CLI',
            subtitle: version.ok ? `${version.stdout} · ${cli.binary}` : version.error,
        }));
        about.add(new Adw.ActionRow({
            title: 'Tuple Deck',
            subtitle: `${this.metadata['version-name'] ?? ''} · unofficial, not affiliated with Tuple`,
        }));
    }

    private _fillExtensionPage(page: Adw.PreferencesPage, settings: Gio.Settings, cli: TupleCli) {
        const general = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(general);
        for (const [key, title, subtitle] of [
            ['show-call-timer', 'Call timer in the top bar', 'Show how long the current call has been running'],
            ['notify-incoming', 'Incoming call notifications', 'Pop up a notification with an Answer button'],
            ['notify-favorites-online', 'Favorites coming online', 'Notify when a favorite contact comes online'],
            ['notify-call-cards', 'Notices posted into the call',
                'Show what agents and integrations post into the call (tuple notifications) as notifications'],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            general.add(row);
        }

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Keyboard shortcuts',
            description: 'Work everywhere in GNOME. Click a row to set its shortcut.',
        });
        page.add(shortcuts);
        for (const shortcut of SHORTCUTS)
            shortcuts.add(shortcutRow(settings, shortcut));

        const paths = new Adw.PreferencesGroup({
            title: 'Programs',
            description: 'GNOME Shell does not see ~/.local/bin on PATH, so these are looked up there too.',
        });
        page.add(paths);

        const tupleRow = new Adw.EntryRow({title: 'tuple CLI path (empty = find automatically)', show_apply_button: true});
        tupleRow.text = settings.get_string('tuple-path');
        const describeTuple = () => {
            const found = cli.binary;
            tupleRow.set_tooltip_text(found ? `Using ${found}` : 'Not found');
            tupleRow.remove_css_class('error');
            if (!found)
                tupleRow.add_css_class('error');
        };
        tupleRow.connect('apply', () => {
            settings.set_string('tuple-path', tupleRow.text.trim());
            describeTuple();
        });
        describeTuple();
        paths.add(tupleRow);

        const updateRow = new Adw.EntryRow({
            title: 'Update command (empty = bundled update-tuple)',
            show_apply_button: true,
        });
        updateRow.text = settings.get_string('update-command');
        updateRow.connect('apply', () => {
            const text = updateRow.text.trim();
            let ok = !text;
            try {
                const [, argv] = GLib.shell_parse_argv(text);
                ok = !!argv?.[0] && !!findProgram(argv[0]);
            } catch {}
            updateRow.remove_css_class('error');
            if (!ok)
                updateRow.add_css_class('error');
            settings.set_string('update-command', text);
        });
        paths.add(updateRow);

        const debug = new Adw.PreferencesGroup({title: 'Troubleshooting'});
        page.add(debug);
        const debugRow = new Adw.SwitchRow({
            title: 'Log call state changes',
            subtitle: 'Writes how Tuple reports calls to ~/.cache/tuple-deck/state-log.ndjson — ' +
                'useful if incoming calls are not detected',
        });
        settings.bind('debug-log', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        debug.add(debugRow);
    }
}
