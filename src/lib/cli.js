// Thin async wrapper around the `tuple` CLI. Imports only GLib/Gio so it works
// both inside GNOME Shell (extension.js) and in the preferences process.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

const PIPES = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
const decoder = new TextDecoder();

// Exit status `tuple call start` uses when the call ends before the callee connects.
export const EXIT_CALL_UNANSWERED = 2;

function isExecutableFile(path) {
    return !!path &&
        GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) &&
        !GLib.file_test(path, GLib.FileTest.IS_DIR);
}

function expandHome(path) {
    return path.startsWith('~/') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]) : path;
}

/**
 * Finds a program the way a login shell would, plus ~/.local/bin and
 * $XDG_BIN_HOME: GNOME Shell's PATH comes from the systemd user manager and
 * usually omits both, which is exactly where `tuple` and `update-tuple` live.
 *
 * An explicit path is used as-is with no fallback, so a misconfigured override
 * fails loudly instead of silently driving a different binary.
 */
export function findProgram(name, explicitPath = '') {
    if (explicitPath) {
        const path = expandHome(explicitPath);
        return isExecutableFile(path) ? path : null;
    }
    const candidates = [GLib.find_program_in_path(name)];
    const xdgBin = GLib.getenv('XDG_BIN_HOME');
    if (xdgBin)
        candidates.push(GLib.build_filenamev([xdgBin, name]));
    candidates.push(GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', name]));
    return candidates.find(isExecutableFile) ?? null;
}

/**
 * Turns CLI error output into one readable line. Handles the three shapes the
 * CLI uses: `{"error": "..."}`, daemon log lines (`12:00:00.000|pid|tid|error|msg`)
 * and cobra's `error: msg` / `Error: msg`.
 */
export function cleanError(text) {
    if (!text)
        return '';
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if (obj?.error)
                return String(obj.error);
        } catch {}
    }
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    // Prefer an explicit error line; fall back to the first line (cobra puts the
    // message first and usage text after it).
    let line = lines.find(l => /\|error\||^error:/i.test(l)) ?? lines[0] ?? '';
    if (line.includes('|'))
        line = line.split('|').pop();
    return line.replace(/^error:\s*/i, '').trim();
}

export class TupleCli {
    /** @param {() => string} getExplicitPath returns the user's override, or '' */
    constructor(getExplicitPath = () => '') {
        this._getExplicitPath = getExplicitPath;
    }

    get binary() {
        return findProgram('tuple', this._getExplicitPath());
    }

    /**
     * Runs `tuple <args>` to completion.
     *
     * @param {string[]} args
     * @param {object} [opts]
     * @param {boolean} [opts.json] pass `--format json` and parse stdout. The
     *   deprecated commands (settings, set, share, ...) reject it, so they run
     *   with json: false.
     * @param {number} [opts.timeout] seconds before the process is killed; 0 = never
     * @param {Gio.Cancellable} [opts.cancellable]
     * @returns {Promise<{ok: boolean, status: number, stdout: string,
     *   stderr: string, data: any, error: string}>}
     */
    async run(args, {json = true, timeout = 30, cancellable = null} = {}) {
        const result = {ok: false, status: -1, stdout: '', stderr: '', data: null, error: ''};
        const bin = this.binary;
        if (!bin) {
            result.error = 'The tuple CLI was not found';
            return result;
        }

        const argv = [bin, ...(json ? ['--format', 'json'] : []), ...args];
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, PIPES);
        } catch (e) {
            result.error = e.message;
            return result;
        }

        let timedOut = false;
        const timerId = timeout > 0
            ? GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                timedOut = true;
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            })
            : 0;

        try {
            const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
            result.stdout = (stdout ?? '').trim();
            result.stderr = (stderr ?? '').trim();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                result.error = e.message;
            proc.force_exit();
        } finally {
            if (timerId && !timedOut)
                GLib.source_remove(timerId);
        }

        result.status = proc.get_if_exited() ? proc.get_exit_status() : -1;
        if (timedOut) {
            result.error = `tuple ${args[0] ?? ''} timed out`;
            return result;
        }

        if (json && result.stdout) {
            try {
                result.data = JSON.parse(result.stdout);
            } catch {
                // Some commands print plain text even with --format json.
            }
        }
        const jsonError = result.data && !Array.isArray(result.data) ? result.data.error : null;
        result.ok = result.status === 0 && !jsonError && !result.error;
        if (!result.ok && !result.error) {
            result.error = jsonError ? String(jsonError)
                : cleanError(result.stderr) || cleanError(result.stdout) ||
                  `tuple ${args.join(' ')} exited with status ${result.status}`;
        }
        return result;
    }

    /** Lists top-level command names (current and deprecated) from `tuple --help`. */
    async commands() {
        const {stdout} = await this.run(['--help'], {json: false, timeout: 10});
        const names = new Set();
        let inList = false;
        for (const line of stdout.split('\n')) {
            if (/^(Available|Deprecated) Commands:/.test(line)) {
                inList = true;
                continue;
            }
            if (!line.trim()) {
                inList = false;
                continue;
            }
            const m = inList && line.match(/^\s+(\S+)/);
            if (m)
                names.add(m[1]);
        }
        return names;
    }
}

/**
 * Keeps one `tuple --format json <args>` streaming command running (state
 * follow, contacts follow, ...) and hands each JSON line to `onData`.
 * Restarts with backoff when the stream ends, e.g. because the daemon was
 * stopped, and reports up/down transitions through `onStatus`.
 */
export class Follower {
    static BACKOFF_SECONDS = [1, 2, 5, 10, 30];

    constructor(cli, args, {onData, onStatus = () => {}}) {
        this._cli = cli;
        this._args = args;
        this._onData = onData;
        this._onStatus = onStatus;
        this._attempt = 0;
        this._proc = null;
        this._cancellable = null;
        this._retryId = 0;
        this._stopped = true;
        this._up = false;
        this._lastError = '';
    }

    start() {
        this._stopped = false;
        this._spawn();
    }

    /** Respawns immediately (e.g. right after `tuple start`). */
    restartNow() {
        if (this._stopped)
            return;
        this._attempt = 0;
        this._kill();
        this._spawn();
    }

    stop() {
        this._stopped = true;
        this._kill();
    }

    _kill() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._proc?.force_exit();
        this._proc = null;
    }

    _spawn() {
        const bin = this._cli.binary;
        if (!bin) {
            this._ended('The tuple CLI was not found');
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new([bin, '--format', 'json', ...this._args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            this._ended(e.message);
            return;
        }
        this._proc = proc;
        this._cancellable = new Gio.Cancellable();
        this._lastError = '';
        const stream = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLoop(proc, stream, this._cancellable).catch(e => logError(e, 'tuple-deck follower'));
    }

    async _readLoop(proc, stream, cancellable) {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null)
                    break;
                // GJS resolves this with bytes, not a string.
                this._handleLine(typeof line === 'string' ? line : decoder.decode(line));
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._lastError = e.message;
        }
        if (this._stopped || proc !== this._proc)
            return;
        this._proc = null;
        this._ended(this._lastError || 'Lost connection to the Tuple app');
    }

    _handleLine(line) {
        const text = line.trim();
        if (!text.startsWith('{') && !text.startsWith('[')) {
            // Merged stderr: daemon log lines and plain-text errors.
            if (text)
                this._lastError = cleanError(text);
            return;
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            return;
        }
        if (data && !Array.isArray(data) && typeof data.error === 'string' && Object.keys(data).length <= 2) {
            this._lastError = data.error;
            return;
        }
        this._attempt = 0;
        if (!this._up) {
            this._up = true;
            this._onStatus(true, '');
        }
        this._onData(data);
    }

    _ended(error) {
        if (this._up || this._attempt === 0) {
            this._up = false;
            this._onStatus(false, error);
        }
        if (this._stopped)
            return;
        const delays = Follower.BACKOFF_SECONDS;
        const delay = delays[Math.min(this._attempt, delays.length - 1)];
        this._attempt++;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }
}
