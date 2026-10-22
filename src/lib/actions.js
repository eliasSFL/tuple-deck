// Everything the menu can do, as `tuple` invocations. Failures surface as
// notifications carrying the CLI's own error text; callers get the raw result.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {EXIT_CALL_UNANSWERED, findProgram} from './cli.js';
import {confirm, openSearchDialog, promptLoginCode, promptText} from './dialogs.js';
import {
    Status, captureCalls, contactRef, firstUrl, machinesOf, parseSettings,
    personName, personalRoom, roomLabel, searchHits,
} from './model.js';
import {Urgency} from './notify.js';

const CAPTURE_UNAVAILABLE_HINT =
    "Tuple's call capture store isn't available on this machine — usually " +
    'because no transcription model is set up yet.';

function friendlyError(error) {
    return /transcription store unavailable/i.test(error) ? CAPTURE_UNAVAILABLE_HINT : error;
}

function timestamp() {
    return GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
}

export class Actions {
    constructor({cli, store, notifier, settings, openPreferences}) {
        this._cli = cli;
        this._store = store;
        this._notifier = notifier;
        this._settings = settings;
        this.openPreferences = openPreferences;
    }

    async _do(args, {label, json = true, timeout = 30, success = null} = {}) {
        const result = await this._cli.run(args, {json, timeout});
        if (!result.ok)
            this._notifier.error(label ? `${label} failed` : 'Tuple', friendlyError(result.error));
        else if (success)
            this._notifier.notify({title: success, urgency: Urgency.LOW});
        return result;
    }

    get _inCall() {
        const s = this._store.status;
        return s === Status.IN_CALL || s === Status.OUTGOING;
    }

    // -- helpers -------------------------------------------------------------

    openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            this._notifier.error("Couldn't open link", e.message);
        }
    }

    copyText(text, what = 'Link') {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._notifier.notify({title: `${what} copied`, body: text, urgency: Urgency.LOW});
    }

    _clipboardText() {
        return new Promise(resolve => {
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text ?? ''));
        });
    }

    // -- daemon & account ------------------------------------------------------

    async startDaemon() {
        await this._do(['start'], {label: 'Starting Tuple', json: false});
        this._store.reconnect();
    }

    async stopDaemon() {
        if (this._inCall && !await confirm({
            title: 'Stop Tuple?',
            description: 'You are in a call. Stopping Tuple will drop you from it.',
            okLabel: 'Stop Tuple',
            destructive: true,
        }))
            return;
        await this._do(['stop'], {label: 'Stopping Tuple', json: false});
        this._store.reconnect();
    }

    async restartDaemon() {
        await this._cli.run(['stop'], {json: false});
        await this.startDaemon();
    }

    async login() {
        const result = await this._cli.run(['login'], {json: false, timeout: 60});
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        if (!result.ok && /already logged in/i.test(output)) {
            this._store.reconnect();
            return;
        }
        const url = firstUrl(output);
        if (url)
            this.openUri(url);
        const code = await promptLoginCode({
            url,
            rawOutput: output || result.error,
            openUri: u => this.openUri(u),
            copyText: t => this.copyText(t),
        });
        if (code) {
            await this._do(['auth', code], {label: 'Logging in', json: false, success: 'Logged in to Tuple'});
            this._store.reconnect();
        }
    }

    async logout() {
        if (!await confirm({
            title: 'Log out of Tuple?',
            description: 'You will stop receiving calls on this machine until you log in again.',
            okLabel: 'Log out',
            destructive: true,
        }))
            return;
        await this._do(['logout'], {label: 'Logging out', json: false});
        this._store.reconnect();
    }

    // -- calls -------------------------------------------------------------------

    /** Rings someone; `tuple call start` waits until they pick up or the call ends. */
    async callContact(contact) {
        const name = personName(contact);
        const result = await this._cli.run(['call', 'start', contactRef(contact)], {timeout: 180});
        if (result.status === EXIT_CALL_UNANSWERED) {
            this._notifier.notify({
                title: `${name} didn't pick up`,
                iconName: 'call-missed-symbolic',
                actions: [['Call again', () => this.callContact(contact)]],
            });
        } else if (!result.ok) {
            this._notifier.error(`Couldn't call ${name}`, result.error);
        }
    }

    async callMachine(machine) {
        const result = await this._cli.run(['call', 'start', machine.id], {timeout: 180});
        if (!result.ok && result.status !== EXIT_CALL_UNANSWERED)
            this._notifier.error(`Couldn't call ${machine.name}`, result.error);
    }

    accept(callId) {
        const args = ['call', 'accept'];
        if (callId)
            args.push('--call', String(callId));
        return this._do(args, {label: 'Answering'});
    }

    async leave() {
        await this._do(['call', 'leave'], {label: 'Leaving the call'});
    }

    setMuted(muted) {
        return this._do(['call', muted ? 'mute' : 'unmute'], {label: muted ? 'Muting' : 'Unmuting'});
    }

    react(sound) {
        return this._do(['call', 'react', sound], {label: 'Reaction'});
    }

    addParticipant(contact) {
        return this._do(['call', 'participants', 'add', contactRef(contact)], {
            label: `Adding ${personName(contact)}`,
        });
    }

    async removeParticipant(participant) {
        if (!await confirm({
            title: `Remove ${participant.name}?`,
            description: 'They will be dropped from the call.',
            okLabel: 'Remove',
            destructive: true,
        }))
            return null;
        return this._do(['call', 'participants', 'remove', participant.email ?? participant.name], {
            label: `Removing ${participant.name}`,
        });
    }

    // Screen sharing and settings only exist as deprecated commands so far, and
    // those reject --format json.
    setSharing(on) {
        return this._do([on ? 'share' : 'unshare'], {
            label: on ? 'Sharing your screen' : 'Stopping screen share',
            json: false,
            timeout: 120,
        });
    }

    async getSettings() {
        const result = await this._cli.run(['settings'], {json: false, timeout: 10});
        return result.ok ? parseSettings(result.stdout) : [];
    }

    setSetting(name, value) {
        return this._do(['set', name, String(value)], {label: `Changing ${name}`, json: false});
    }

    async snapshot() {
        const dir = GLib.build_filenamev([
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir(),
            'Tuple',
        ]);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, `tuple-${timestamp()}.jpg`]);
        const result = await this._do(['screen', '-o', path], {label: 'Screenshot'});
        if (result.ok) {
            const uri = Gio.File.new_for_path(path).get_uri();
            this._notifier.notify({
                title: 'Saved screenshot of the shared screen',
                body: path,
                iconName: 'camera-photo-symbolic',
                actions: [
                    ['Open', () => this.openUri(uri)],
                    ['Show folder', () => this.openUri(Gio.File.new_for_path(dir).get_uri())],
                ],
            });
        }
    }

    setCapturing(on) {
        return this._do(['capture', on ? 'start' : 'stop'], {
            label: on ? 'Starting capture' : 'Stopping capture',
            success: on ? 'Capturing this call' : 'Stopped capturing',
        });
    }

    // -- rooms -------------------------------------------------------------------

    async joinRoom(room) {
        const args = ['rooms', 'join', room.http_value || room.slug];
        if (this._inCall) {
            if (!await confirm({
                title: `Switch to ${roomLabel(room)}?`,
                description: 'You will leave your current call.',
                okLabel: 'Switch',
            }))
                return;
            args.push('--switch');
        }
        await this._do(args, {label: `Joining ${roomLabel(room)}`});
    }

    async startInMyRoom() {
        const room = personalRoom(this._store.rooms);
        if (!room) {
            this._notifier.error('No personal room', 'Tuple did not report a personal room for your account.');
            return;
        }
        await this.joinRoom(room);
    }

    async joinFromClipboard() {
        const text = (await this._clipboardText()).trim();
        const url = firstUrl(text);
        if (!url || !/tuple\.app\//.test(url)) {
            this._notifier.error('No Tuple link on the clipboard', 'Copy a tuple.app call or room link first.');
            return;
        }
        await this._do(['call', 'join', url, ...(this._inCall ? ['--switch'] : [])], {label: 'Joining'});
    }

    async createRoom() {
        const name = await promptText({
            title: 'New team room',
            description: 'Your teammates will see it in their room list.',
            hint: 'Room name',
            okLabel: 'Create',
        });
        if (!name)
            return;
        const result = await this._do(['rooms', 'create', name], {label: 'Creating room'});
        const url = result.data?.http_value;
        if (result.ok) {
            this._notifier.notify({
                title: `Created ${name}`,
                body: url ?? '',
                urgency: Urgency.LOW,
                actions: url ? [['Copy link', () => this.copyText(url)]] : [],
            });
        }
    }

    toggleRoomFavorite(room) {
        return this._do(['rooms', room.favorited ? 'unfavorite' : 'favorite', room.http_value || room.slug], {
            label: 'Updating favorites',
        });
    }

    toggleContactFavorite(contact) {
        return this._do(['contacts', contact.favorited ? 'unfavorite' : 'favorite', contactRef(contact)], {
            label: 'Updating favorites',
        });
    }

    // -- machines ----------------------------------------------------------------

    async machines() {
        const result = await this._cli.run(['machines', 'list'], {timeout: 10});
        return result.ok ? machinesOf(result.data) : [];
    }

    // -- history (tuple capture) -------------------------------------------------

    async recentCalls(limit = 8) {
        const result = await this._cli.run(['capture', 'list', '--limit', String(limit)], {timeout: 15});
        return result.ok ? {calls: captureCalls(result.data), error: ''}
            : {calls: [], error: friendlyError(result.error)};
    }

    /** Exports one stored call as Markdown into the cache dir and opens it. */
    async openCall(callId) {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'tuple-deck', 'calls']);
        GLib.mkdir_with_parents(dir, 0o700);
        const dest = GLib.build_filenamev([dir, `${callId}.md`]);
        const result = await this._do(['capture', 'export', dest, '--call', callId, '--as', 'markdown'], {
            label: 'Opening call',
            timeout: 60,
        });
        if (result.ok)
            this.openUri(Gio.File.new_for_path(dest).get_uri());
    }

    openSearch() {
        openSearchDialog({
            search: async query => {
                const result = await this._cli.run(['capture', 'search', query, '--limit', '30'], {timeout: 30});
                return result.ok ? {hits: searchHits(result.data), error: ''}
                    : {hits: [], error: friendlyError(result.error)};
            },
            onPick: hit => this.openCall(hit.callId),
        });
    }

    // -- updates -------------------------------------------------------------------

    /** Runs the configured updater (default: update-tuple) and offers a daemon restart. */
    async update() {
        let argv;
        try {
            [, argv] = GLib.shell_parse_argv(this._settings.get_string('update-command'));
        } catch (e) {
            this._notifier.error('Update command is invalid', e.message);
            return;
        }
        const program = findProgram(argv[0]);
        if (!program) {
            this._notifier.error('Updater not found', `Couldn't find "${argv[0]}". Set the update command in the extension settings.`);
            return;
        }
        this._notifier.notify({title: 'Updating Tuple…', urgency: Urgency.LOW});
        let ok = false;
        let output = '';
        try {
            const proc = Gio.Subprocess.new([program, ...argv.slice(1)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            const [stdout] = await proc.communicate_utf8_async(null, null);
            ok = proc.get_successful();
            output = (stdout ?? '').trim();
        } catch (e) {
            output = e.message;
        }
        const lastLine = output.split('\n').filter(Boolean).at(-1) ?? '';
        if (!ok) {
            this._notifier.error('Tuple update failed', lastLine);
            return;
        }
        this._notifier.notify({
            title: 'Tuple updated',
            body: `${lastLine}\nRestart Tuple to start using the new version.`,
            actions: this._inCall ? [] : [['Restart Tuple', () => this.restartDaemon()]],
        });
    }
}
