// Everything the menu can do, as `tuple` invocations. Failures surface as
// notifications carrying the CLI's own error text; callers get the raw result.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {EXIT_CALL_UNANSWERED, type RunResult, type TupleCli, findProgram} from './cli.js';
import {confirm, openSearchDialog, promptLoginCode, promptText} from './dialogs.js';
import {
    type CallMember, type CaptureCall, type Contact, type Id, type Machine, type OngoingCall,
    type Reaction, type Room, type TupleSetting,
    Status, captureCalls, contactRef, firstUrl, machinesOf, ongoingCallLabel, ongoingCalls,
    parseSettings, personName, personalRoom, roomLabel, searchHits,
} from './model.js';
import {type Notifier, Urgency} from './notify.js';
import type {TupleStore} from './store.js';

const CAPTURE_UNAVAILABLE_HINT =
    "Tuple's call capture store isn't available on this machine — usually " +
    'because no transcription model is set up yet.';

function friendlyError(error: string): string {
    return /transcription store unavailable/i.test(error) ? CAPTURE_UNAVAILABLE_HINT : error;
}

function timestamp(): string {
    return GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S') ?? '';
}

export class Actions {
    openPreferences: () => void;
    private _cli: TupleCli;
    private _store: TupleStore;
    private _notifier: Notifier;
    private _settings: Gio.Settings;
    private _bundledUpdater: string;

    constructor({cli, store, notifier, settings, openPreferences, bundledUpdater}: {
        cli: TupleCli,
        store: TupleStore,
        notifier: Notifier,
        settings: Gio.Settings,
        openPreferences: () => void,
        /** path of the update-tuple script shipped in the extension */
        bundledUpdater: string,
    }) {
        this._cli = cli;
        this._store = store;
        this._notifier = notifier;
        this._settings = settings;
        this.openPreferences = openPreferences;
        this._bundledUpdater = bundledUpdater;
    }

    /** Runs `tuple <args>`; failures become a "<label> failed" notification. */
    private async _do(args: string[], {label, json = true, timeout = 30, success = null}: {
        label?: string, json?: boolean, timeout?: number, success?: string | null,
    } = {}): Promise<RunResult> {
        const result = await this._cli.run(args, {json, timeout});
        if (!result.ok)
            this._notifier.error(label ? `${label} failed` : 'Tuple', friendlyError(result.error));
        else if (success)
            this._notifier.notify({title: success, urgency: Urgency.LOW});
        return result;
    }

    private get _inCall(): boolean {
        const s = this._store.status;
        return s === Status.IN_CALL || s === Status.OUTGOING;
    }

    // -- helpers -------------------------------------------------------------

    openUri(uri: string) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            this._notifier.error("Couldn't open link", (e as Error).message);
        }
    }

    copyText(text: string, what = 'Link') {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._notifier.notify({title: `${what} copied`, body: text, urgency: Urgency.LOW});
    }

    private _clipboardText(): Promise<string> {
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
    async callContact(contact: Contact): Promise<void> {
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

    async callMachine(machine: Machine): Promise<void> {
        const result = await this._cli.run(['call', 'start', machine.id], {timeout: 180});
        if (!result.ok && result.status !== EXIT_CALL_UNANSWERED)
            this._notifier.error(`Couldn't call ${machine.name}`, result.error);
    }

    accept(callId?: Id | null): Promise<RunResult> {
        const args = ['call', 'accept'];
        if (callId)
            args.push('--call', String(callId));
        return this._do(args, {label: 'Answering'});
    }

    /** Calls in progress that you could join (`call list --joinable`). */
    async ongoingCalls(): Promise<OngoingCall[]> {
        const result = await this._cli.run(['call', 'list', '--joinable', '--limit', '20'], {timeout: 10});
        return result.ok ? ongoingCalls(result.data) : [];
    }

    async joinCall(call: OngoingCall): Promise<void> {
        const name = ongoingCallLabel(call);
        const args = ['call', 'join', call.target];
        if (this._inCall) {
            if (!await this._confirmSwitch(name))
                return;
            args.push('--switch');
        }
        await this._do(args, {label: `Joining ${name}`});
    }

    private _confirmSwitch(name: string): Promise<boolean> {
        return confirm({
            title: `Switch to ${name}?`,
            description: 'You will leave your current call.',
            okLabel: 'Switch',
        });
    }

    async leave() {
        await this._do(['call', 'leave'], {label: 'Leaving the call'});
    }

    setMuted(muted: boolean): Promise<RunResult> {
        return this._do(['call', muted ? 'mute' : 'unmute'], {label: muted ? 'Muting' : 'Unmuting'});
    }

    react(sound: Reaction): Promise<RunResult> {
        return this._do(['call', 'react', sound], {label: 'Reaction'});
    }

    addParticipant(contact: Contact): Promise<RunResult> {
        return this._do(['call', 'participants', 'add', contactRef(contact)], {
            label: `Adding ${personName(contact)}`,
        });
    }

    async removeParticipant(participant: CallMember): Promise<RunResult | null> {
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
    setSharing(on: boolean): Promise<RunResult> {
        return this._do([on ? 'share' : 'unshare'], {
            label: on ? 'Sharing your screen' : 'Stopping screen share',
            json: false,
            timeout: 120,
        });
    }

    async getSettings(): Promise<TupleSetting[]> {
        const result = await this._cli.run(['settings'], {json: false, timeout: 10});
        return result.ok ? parseSettings(result.stdout) : [];
    }

    setSetting(name: string, value: string | number): Promise<RunResult> {
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

    setCapturing(on: boolean): Promise<RunResult> {
        return this._do(['capture', on ? 'start' : 'stop'], {
            label: on ? 'Starting capture' : 'Stopping capture',
            success: on ? 'Capturing this call' : 'Stopped capturing',
        });
    }

    // -- rooms -------------------------------------------------------------------

    async joinRoom(room: Room): Promise<void> {
        const args = ['rooms', 'join', room.http_value || room.slug];
        if (this._inCall) {
            if (!await this._confirmSwitch(roomLabel(room)))
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

    toggleRoomFavorite(room: Room): Promise<RunResult> {
        return this._do(['rooms', room.favorited ? 'unfavorite' : 'favorite', room.http_value || room.slug], {
            label: 'Updating favorites',
        });
    }

    toggleContactFavorite(contact: Contact): Promise<RunResult> {
        return this._do(['contacts', contact.favorited ? 'unfavorite' : 'favorite', contactRef(contact)], {
            label: 'Updating favorites',
        });
    }

    async inviteContact() {
        const email = await promptText({
            title: 'Invite someone to Tuple',
            description: 'They get an email invitation to Tuple.',
            hint: 'Email address',
            okLabel: 'Send invite',
        });
        if (!email)
            return;
        if (!/^\S+@\S+\.\S+$/.test(email)) {
            this._notifier.error('Not an email address', email);
            return;
        }
        await this._do(['contacts', 'invite', email], {label: 'Inviting', success: `Invited ${email}`});
    }

    async removeContact(contact: Contact): Promise<void> {
        const name = personName(contact);
        if (!await confirm({
            title: `Remove ${name} from your contacts?`,
            description: 'They will no longer show up in your contact list.',
            okLabel: 'Remove',
            destructive: true,
        }))
            return;
        await this._do(['contacts', 'remove', contactRef(contact)], {label: `Removing ${name}`});
    }

    // -- machines ----------------------------------------------------------------

    async machines(): Promise<Machine[]> {
        const result = await this._cli.run(['machines', 'list'], {timeout: 10});
        return result.ok ? machinesOf(result.data) : [];
    }

    // -- history (tuple capture) -------------------------------------------------

    async recentCalls(limit = 8): Promise<{calls: CaptureCall[], error: string}> {
        const result = await this._cli.run(['capture', 'list', '--limit', String(limit)], {timeout: 15});
        return result.ok ? {calls: captureCalls(result.data), error: ''}
            : {calls: [], error: friendlyError(result.error)};
    }

    /** Exports one stored call as Markdown into the cache dir and opens it. */
    async openCall(callId: string): Promise<void> {
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

    /** Deletes one stored call capture; resolves true when it was deleted. */
    async deleteCapture(call: CaptureCall): Promise<boolean> {
        if (!await confirm({
            title: `Delete "${call.title}"?`,
            description: "Its transcript, screen content and media are deleted from this machine. This can't be undone.",
            okLabel: 'Delete',
            destructive: true,
        }))
            return false;
        const result = await this._do(['capture', 'delete', call.id], {label: 'Deleting call'});
        return result.ok;
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

    /**
     * Runs the bundled update-tuple script, or the user's own update command
     * if one is set, and offers a daemon restart.
     */
    async update() {
        let program = '/bin/bash';
        // Run through bash: packing/installing the zip may drop the exec bit.
        let argv: string[] = [program, this._bundledUpdater];
        const custom = this._settings.get_string('update-command').trim();
        if (custom) {
            try {
                argv = GLib.shell_parse_argv(custom)[1] ?? [];
            } catch (e) {
                this._notifier.error('Update command is invalid', (e as Error).message);
                return;
            }
            const found = findProgram(argv[0]);
            if (!found) {
                this._notifier.error('Updater not found', `Couldn't find "${argv[0]}". Fix the update command in the extension settings, or clear it to use the bundled one.`);
                return;
            }
            program = found;
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
            output = (e as Error).message;
        }
        // curl's progress bar shares the line with \r redraws; keep the final frame.
        const lines = output.split('\n').map(l => (l.split('\r').at(-1) ?? '').trim()).filter(Boolean);
        if (!ok) {
            this._notifier.error('Tuple update failed', lines.at(-1) ?? '');
            return;
        }
        if (lines.some(l => /^Already up to date/.test(l))) {
            this._notifier.notify({title: 'Tuple is already up to date', urgency: Urgency.LOW});
            return;
        }
        // update-tuple prints "Done. Tuple is now at version: vX".
        const version = lines.join('\n').match(/now at version:\s*(\S+)/)?.[1];
        this._notifier.notify({
            title: 'Tuple updated',
            body: `${version ? `Now at ${version}. ` : ''}Restart Tuple to start using it.`,
            actions: this._inCall ? [] : [['Restart Tuple', () => this.restartDaemon()]],
        });
    }
}
