import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Actions} from './lib/actions.js';
import {TupleCli} from './lib/cli.js';
import {TupleIndicator} from './lib/indicator.js';
import {SHORTCUTS, Status, callerName, personName} from './lib/model.js';
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
            'card', (_s, card) => this._onCard(card),
            'card-closed', (_s, id) => this._closeCard(id),
            this);
        this._cardNotifications = new Map();
        this._bindShortcuts();
        // Restart the CLI streams when the binary override changes.
        this._settings.connectObject('changed::tuple-path', () => this._store.reconnect(), this);
        this._store.start();
    }

    disable() {
        for (const {key} of SHORTCUTS)
            Main.wm.removeKeybinding(key);
        this._settings.disconnectObject(this);
        this._store.disconnectObject(this);
        this._clearIncoming();
        for (const id of [...this._cardNotifications.keys()])
            this._closeCard(id);
        this._cardNotifications = null;
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

    // -- notification cards posted into the call ----------------------------------

    _onCard(card) {
        if (!this._settings.get_boolean('notify-call-cards'))
            return;
        // The CLI can't answer a card (only the Tuple app can), so an ask only
        // says where to answer it.
        const footer = [card.sender && `From ${card.sender}`, card.ask && 'Answer it in Tuple'].filter(Boolean).join(' · ');
        const notification = this._notifier.notify({
            title: card.title || card.sender || 'Tuple',
            body: [card.body, footer].filter(Boolean).join('\n'),
            urgency: card.ask ? Urgency.HIGH : Urgency.NORMAL,
        });
        this._cardNotifications.set(card.id, notification);
        notification.connect('destroy', () => {
            if (this._cardNotifications?.get(card.id) === notification)
                this._cardNotifications.delete(card.id);
        });
    }

    _closeCard(id) {
        this._cardNotifications.get(id)?.destroy();
        this._cardNotifications.delete(id);
    }

    // -- keyboard shortcuts ---------------------------------------------------------

    _bindShortcuts() {
        const handlers = {
            'shortcut-toggle-mute': () => this._shortcutToggleMute(),
            'shortcut-answer': () => this._shortcutAnswer(),
            'shortcut-leave': () => this._shortcutLeave(),
            'shortcut-join-clipboard': () => this._actions.joinFromClipboard(),
        };
        for (const {key} of SHORTCUTS) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                handlers[key]);
        }
    }

    _osd(iconName, label) {
        Main.osdWindowManager.showAll(Gio.ThemedIcon.new(iconName), label, null, null);
    }

    _shortcutToggleMute() {
        const muted = this._indicator.toggleMute();
        if (muted === null)
            this._osd('microphone-disabled-symbolic', 'Not in a Tuple call');
        else
            this._osd(muted ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic',
                muted ? 'Muted' : 'Unmuted');
    }

    _shortcutAnswer() {
        if (this._store.status === Status.INCOMING)
            this._actions.accept(this._store.call?.id);
        else
            this._osd('call-incoming-symbolic', 'No call is ringing');
    }

    _shortcutLeave() {
        const status = this._store.status;
        if (status === Status.IN_CALL || status === Status.OUTGOING) {
            this._osd('call-stop-symbolic', status === Status.OUTGOING ? 'Call cancelled' : 'Left the call');
            this._actions.leave();
        } else {
            this._osd('call-stop-symbolic', 'Not in a Tuple call');
        }
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
