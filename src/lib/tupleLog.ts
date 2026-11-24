// Follows the Tuple daemon's log ($XDG_DATA_HOME/tuple/<n>/log.txt) for the
// one thing the CLI doesn't report: whether you're sharing your screen or
// webcam. See applyMediaLog() in model.ts for the lines it looks for.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {type MediaState, applyMediaLog} from './model.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

// Only the tail of a long log is read at startup; sharing state older than
// this would be long stale anyway.
const MAX_INITIAL_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();

/** The most recently written Tuple log, or null. */
function findLog(): Gio.File | null {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'tuple']));
    let best: Gio.File | null = null;
    let bestTime = -1;
    try {
        const children = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const log = dir.get_child(info.get_name()).get_child('log.txt');
            try {
                const time = log.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
                    .get_attribute_uint64('time::modified');
                if (time > bestTime) {
                    best = log;
                    bestTime = time;
                }
            } catch {
                // no log in this one
            }
        }
        children.close(null);
    } catch {
        // no Tuple data dir
    }
    return best;
}

export class TupleLogWatcher {
    /** null until the log has shown at least one sharing line (or a daemon start). */
    state: MediaState | null = null;

    private _onChange: () => void;
    private _file: Gio.File | null = null;
    private _monitor: Gio.FileMonitor | null = null;
    private _offset = 0;
    private _partial = '';
    private _media: MediaState = {screen: false, webcam: false};
    private _reading = false;
    private _again = false;
    private _cancellable = new Gio.Cancellable();

    constructor(onChange: () => void) {
        this._onChange = onChange;
    }

    /** (Re)finds the log, e.g. after the daemon restarted, and reads it. */
    start() {
        const file = findLog();
        this._offset = 0;
        this._partial = '';
        this._media = {screen: false, webcam: false};
        if (file && this._file && file.equal(this._file) && this._monitor) {
            this._read();
            return;
        }
        this._monitor?.cancel();
        this._monitor = null;
        this._file = file;
        if (!file)
            return;
        try {
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._read());
        } catch (e) {
            logError(e as object, 'tuple-deck: watching the Tuple log');
        }
        this._read();
    }

    stop() {
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
    }

    private async _read() {
        if (this._reading) {
            this._again = true;
            return;
        }
        this._reading = true;
        try {
            do {
                this._again = false;
                await this._readNew();
            } while (this._again);
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                logError(e as object, 'tuple-deck: reading the Tuple log');
        } finally {
            this._reading = false;
        }
    }

    private async _readNew() {
        const file = this._file;
        if (!file)
            return;
        let size;
        try {
            const info = await file.query_info_async('standard::size', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, this._cancellable);
            size = info.get_size();
        } catch {
            return; // gone for now; the monitor reports when it's back
        }
        if (size < this._offset) {
            // Rewritten by a new daemon: start over.
            this._offset = 0;
            this._partial = '';
            this._apply('launching from pid\n');
        }
        if (size === this._offset)
            return;
        if (this._offset === 0 && size > MAX_INITIAL_BYTES)
            this._offset = size - MAX_INITIAL_BYTES;

        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        try {
            stream.seek(this._offset, GLib.SeekType.SET, this._cancellable);
            const bytes = await stream.read_bytes_async(size - this._offset, GLib.PRIORITY_DEFAULT, this._cancellable);
            const data = bytes.get_data();
            const length = data?.length ?? 0;
            this._offset += length;
            const text = this._partial + (data ? decoder.decode(data) : '');
            const cut = text.lastIndexOf('\n');
            this._partial = text.slice(cut + 1);
            if (cut >= 0)
                this._apply(text.slice(0, cut + 1));
        } finally {
            stream.close(null);
        }
    }

    private _apply(text: string) {
        const {state, matched} = applyMediaLog(this._media, text);
        this._media = state;
        if (!matched)
            return;
        const changed = !this.state || this.state.screen !== state.screen || this.state.webcam !== state.webcam;
        this.state = state;
        if (changed)
            this._onChange();
    }
}
