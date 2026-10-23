import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Actions} from './lib/actions.js';
import {TupleCli} from './lib/cli.js';
import {TupleIndicator} from './lib/indicator.js';
import {callerName, personName} from './lib/model.js';
import {Notifier, Urgency} from './lib/notify.js';
import {TupleStore} from './lib/store.js';

export default class TupleDeckExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Tuple's own app icon, as installed with the client (Icon=tuple in
        // its .desktop file); a generic call icon where it isn't installed.
        this._gicon = Gio.ThemedIcon.new_from_names(['tuple', 'call-start-symbolic']);
        this._cli = new TupleCli(() => this._settings.get_string('tuple-path'));
        this._store = new TupleStore(this._cli, this._settings);
        this._notifier = new Notifier(this._gicon);
        this._actions = new Actions({
            cli: this._cli,
            store: this._store,
            notifier: this._notifier,
            settings: this._settings,
            openPreferences: () => this.openPreferences(),
            bundledUpdater: `${this.path}/bin/update-tuple`,
        });
        this._indicator = new TupleIndicator({
            store: this._store,
            actions: this._actions,
            settings: this._settings,
            gicon: this._gicon,
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._store.connectObject(
            'incoming', (_s, call) => this._onIncoming(call),
            'incoming-cleared', () => this._clearIncoming(),
            'favorite-online', (_s, contact) => this._onFavoriteOnline(contact),
            this);
        // Restart the CLI streams when the binary override changes.
        this._settings.connectObject('changed::tuple-path', () => this._store.reconnect(), this);
        this._store.start();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._store.disconnectObject(this);
        this._clearIncoming();
        this._indicator.destroy();
        this._store.destroy();
        this._notifier.destroy();
        this._indicator = null;
        this._store = null;
        this._notifier = null;
        this._actions = null;
        this._cli = null;
        this._settings = null;
        this._gicon = null;
    }

    _onIncoming(call) {
        if (!this._settings.get_boolean('notify-incoming'))
            return;
        this._clearIncoming();
        this._incomingNotification = this._notifier.notify({
            title: `${callerName(call, this._store.selfId)} is calling`,
            body: call.title || 'Incoming Tuple call',
            iconName: 'call-incoming-symbolic',
            urgency: Urgency.CRITICAL,
            actions: [['Answer', () => this._actions.accept(call.id)]],
        });
        this._incomingNotification.connect('destroy', () => {
            this._incomingNotification = null;
        });
    }

    _clearIncoming() {
        this._incomingNotification?.destroy();
        this._incomingNotification = null;
    }

    _onFavoriteOnline(contact) {
        if (!this._settings.get_boolean('notify-favorites-online'))
            return;
        this._notifier.notify({
            title: `${personName(contact)} is online`,
            urgency: Urgency.LOW,
            iconName: 'user-available-symbolic',
            actions: [['Call', () => this._actions.callContact(contact)]],
        });
    }
}
