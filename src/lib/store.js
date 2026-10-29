// Live view of the Tuple app, fed by three long-running CLI streams:
//   tuple --format json state follow     -> bounded summary (call, user, connection)
//   tuple --format json contacts follow  -> full contact list snapshots
//   tuple --format json rooms follow     -> full room list snapshots
// plus, only while in a call (the command errors outside one):
//   tuple --format json notifications follow -> cards posted into the call
//
// Signals:
//   'changed'                      anything changed; read the getters
//   'incoming' (call)              a call started ringing for us
//   'incoming-cleared'             it was answered, declined or missed
//   'favorite-online' (contact)    a favorite came online (after the first snapshot)
//   'card' (card)                  a notification card was posted into the call
//   'card-closed' (id)             it was answered, withdrawn, or the call ended

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {Follower} from './cli.js';
import {Status, callPhase, deriveStatus, isOnline, notificationCards} from './model.js';

export class TupleStore extends Signals.EventEmitter {
    constructor(cli, settings) {
        super();
        this._cli = cli;
        this._settings = settings;
        this.state = null;
        this.contacts = [];
        this.rooms = [];
        this.daemonUp = false;
        this.error = '';
        this.commands = new Set();
        this.identity = null;
        this._identityFor = null;
        this._incomingId = null;
        this._cards = new Map();
        this._cardsOn = false;
        this._cardsCall = null;
        this._contactsSeen = false;
        this._lastLoggedCall = undefined;

        this._stateFollower = new Follower(cli, ['state', 'follow'], {
            onData: data => this._onState(data),
            onStatus: (up, error) => this._onDaemonStatus(up, error),
        });
        this._contactsFollower = new Follower(cli, ['contacts', 'follow'], {
            onData: data => this._onContacts(data),
        });
        this._roomsFollower = new Follower(cli, ['rooms', 'follow'], {
            onData: data => this._onRooms(data),
        });
        this._followers = [this._stateFollower, this._contactsFollower, this._roomsFollower];
        this._cardsFollower = new Follower(cli, ['notifications', 'follow'], {
            onData: data => this._onCards(data),
        });
    }

    start() {
        this._followers.forEach(f => f.start());
        this.refreshCommands();
    }

    destroy() {
        this._followers.forEach(f => f.stop());
        this._cardsFollower.stop();
        this.disconnectAll?.();
    }

    /** Reconnect all streams now, e.g. after starting the daemon or logging in. */
    reconnect() {
        this._followers.forEach(f => f.restartNow());
        this._cardsFollower.restartNow();
        this.refreshCommands();
    }

    async refreshCommands() {
        try {
            this.commands = await this._cli.commands();
        } catch (e) {
            logError(e, 'tuple-deck: reading tuple --help');
        }
        this._syncCards();
        this.emit('changed');
    }

    /** Whether the installed CLI still has a (possibly deprecated) command. */
    has(command) {
        return this.commands.has(command);
    }

    get status() {
        return deriveStatus(this.state, this.daemonUp);
    }

    get call() {
        return this.state?.call ?? null;
    }

    get selfId() {
        return this.state?.user?.id ?? null;
    }

    get updateVersion() {
        return this.state?.available_update_version ?? null;
    }

    _onDaemonStatus(up, error) {
        this.daemonUp = up;
        this.error = error;
        if (!up) {
            this.state = null;
            this._setIncoming(null);
            this._syncCards();
        }
        this.emit('changed');
    }

    _onState(data) {
        this.state = data;
        this.daemonUp = true;
        this.error = '';
        if (this._settings.get_boolean('debug-log'))
            this._logCall(data);
        this._setIncoming(this.status === Status.INCOMING ? data.call : null);
        this._syncIdentity(data.user);
        this._syncCards();
        this.emit('changed');
    }

    // `state` only carries the short name; whoami has the full identity.
    _syncIdentity(user) {
        const id = user?.id ?? null;
        if (id === this._identityFor)
            return;
        this._identityFor = id;
        this.identity = null;
        if (id !== null)
            this._loadIdentity(id);
    }

    async _loadIdentity(id) {
        const result = await this._cli.run(['whoami'], {timeout: 10});
        if (result.ok && id === this._identityFor && String(result.data?.id) === String(id)) {
            this.identity = result.data;
            this.emit('changed');
        }
    }

    // -- notification cards --------------------------------------------------

    /** Follows the call's notification cards while in a call, and closes them all after. */
    _syncCards() {
        const want = this.status === Status.IN_CALL && this.has('notifications');
        const callId = want ? String(this.call?.id ?? 'call') : null;
        if (callId === this._cardsCall)
            return;
        this._cardsCall = callId;
        if (this._cardsOn) {
            this._cardsFollower.stop();
            this._cardsOn = false;
        }
        for (const id of this._cards.keys())
            this.emit('card-closed', id);
        this._cards.clear();
        if (want) {
            this._cardsFollower.start();
            this._cardsOn = true;
        }
    }

    _onCards(data) {
        this._debugLog('notifications-log.ndjson', data);
        const {snapshot, cards} = notificationCards(data);
        const seen = new Set();
        for (const card of cards) {
            seen.add(card.id);
            if (card.open && !this._cards.has(card.id)) {
                this._cards.set(card.id, card);
                this.emit('card', card);
            } else if (!card.open && this._cards.delete(card.id)) {
                this.emit('card-closed', card.id);
            }
        }
        if (snapshot) {
            for (const id of [...this._cards.keys()]) {
                if (!seen.has(id)) {
                    this._cards.delete(id);
                    this.emit('card-closed', id);
                }
            }
        }
    }

    _setIncoming(call) {
        const id = call ? String(call.id ?? 'ringing') : null;
        if (id === this._incomingId)
            return;
        const wasRinging = this._incomingId !== null;
        this._incomingId = id;
        if (wasRinging)
            this.emit('incoming-cleared');
        if (call)
            this.emit('incoming', call);
    }

    _onContacts(data) {
        if (!Array.isArray(data))
            return;
        if (this._contactsSeen) {
            const before = new Map(this.contacts.map(c => [c.id, c]));
            for (const c of data) {
                const prev = before.get(c.id);
                if (c.favorited && isOnline(c) && prev && !isOnline(prev))
                    this.emit('favorite-online', c);
            }
        }
        this._contactsSeen = true;
        this.contacts = data;
        this.emit('changed');
    }

    _onRooms(data) {
        if (!Array.isArray(data))
            return;
        this.rooms = data;
        this.emit('changed');
    }

    // Records how the daemon reports calls, so call detection can be checked
    // against a real incoming call. Only writes when the call part changes.
    _logCall(data) {
        const callJson = JSON.stringify({in_call: data.in_call, call: data.call, phase: callPhase(data)});
        if (callJson === this._lastLoggedCall)
            return;
        this._lastLoggedCall = callJson;
        this._debugLog('state-log.ndjson', JSON.parse(callJson));
    }

    // Appends one line to ~/.cache/tuple-deck/<name> when debug logging is on.
    _debugLog(name, data) {
        if (!this._settings.get_boolean('debug-log'))
            return;
        try {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'tuple-deck']);
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
            const stream = file.append_to(Gio.FileCreateFlags.PRIVATE, null);
            const at = new Date().toISOString();
            const entry = data && typeof data === 'object' && !Array.isArray(data) ? {at, ...data} : {at, data};
            const line = `${JSON.stringify(entry)}\n`;
            stream.write_all(new TextEncoder().encode(line), null);
            stream.close(null);
        } catch (e) {
            logError(e, 'tuple-deck: debug log');
        }
    }
}
