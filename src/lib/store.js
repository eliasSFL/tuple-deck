// Live view of the Tuple app, fed by three long-running CLI streams:
//   tuple --format json state follow     -> bounded summary (call, user, connection)
//   tuple --format json contacts follow  -> full contact list snapshots
//   tuple --format json rooms follow     -> full room list snapshots
//
// Signals:
//   'changed'                      anything changed; read the getters
//   'incoming' (call)              a call started ringing for us
//   'incoming-cleared'             it was answered, declined or missed
//   'favorite-online' (contact)    a favorite came online (after the first snapshot)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {Follower} from './cli.js';
import {Status, callPhase, deriveStatus, isOnline} from './model.js';

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
        this._incomingId = null;
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
    }

    start() {
        this._followers.forEach(f => f.start());
        this.refreshCommands();
    }

    destroy() {
        this._followers.forEach(f => f.stop());
        this.disconnectAll?.();
    }

    /** Reconnect all streams now, e.g. after starting the daemon or logging in. */
    reconnect() {
        this._followers.forEach(f => f.restartNow());
        this.refreshCommands();
    }

    async refreshCommands() {
        try {
            this.commands = await this._cli.commands();
        } catch (e) {
            logError(e, 'tuple-deck: reading tuple --help');
        }
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
        }
        this.emit('changed');
    }

    _onState(data) {
        this.state = data;
        this.daemonUp = true;
        this.error = '';
        this._debugLog(data);
        this._setIncoming(this.status === Status.INCOMING ? data.call : null);
        this.emit('changed');
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
    _debugLog(data) {
        if (!this._settings.get_boolean('debug-log'))
            return;
        const callJson = JSON.stringify({in_call: data.in_call, call: data.call, phase: callPhase(data)});
        if (callJson === this._lastLoggedCall)
            return;
        this._lastLoggedCall = callJson;
        try {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'tuple-deck']);
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'state-log.ndjson']));
            const stream = file.append_to(Gio.FileCreateFlags.PRIVATE, null);
            const line = `${JSON.stringify({at: new Date().toISOString(), ...JSON.parse(callJson)})}\n`;
            stream.write_all(new TextEncoder().encode(line), null);
            stream.close(null);
        } catch (e) {
            logError(e, 'tuple-deck: debug log');
        }
    }
}
