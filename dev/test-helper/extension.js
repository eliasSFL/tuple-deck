// Runs a test plan inside the headless sandbox Shell (see dev/sandbox.sh):
// opens menus, clicks actors with a virtual pointer, swaps mock-tuple
// scenarios and takes screenshots. Writes <out>/done when finished.
//
// A plan is a JSON array of [op, arg] steps:
//   ["scenario", "in-call"]   copy dev/fixtures/<name>/*.json into the mock dir
//   ["wait", 500]             milliseconds
//   ["shot", "01-idle"]       screenshot to <out>/01-idle.png
//   ["click", "<js expr>"]    click the centre of the actor the expression returns
//   ["eval", "<js body>"]     async body with ctx helpers in scope; may return a value to log
//   ["expect", "<regex>"]     assert that commands.log (since the last expect) matches

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot');

const DECK_UUID = 'tuple-deck@eliassfl.github.io';
const env = name => GLib.getenv(name) ?? '';

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function readText(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return '';
    }
}

function writeText(path, text) {
    GLib.file_set_contents(path, text);
}

export default class TestHelper extends Extension {
    enable() {
        this._out = env('TUPLE_DECK_TEST_OUT');
        this._mock = env('TUPLE_MOCK_DIR');
        this._fixtures = env('TUPLE_DECK_FIXTURES');
        this._logOffset = 0;
        this._failures = 0;
        this._run()
            .catch(e => {
                this._failures++;
                this._log(`ERROR ${e}\n${e.stack}`);
            })
            .finally(() => writeText(`${this._out}/done`, `${this._failures}\n`));
    }

    disable() {}

    _log(text) {
        const path = `${this._out}/helper.log`;
        writeText(path, `${readText(path)}${text}\n`);
    }

    get _deck() {
        return Main.extensionManager.lookup(DECK_UUID)?.stateObj ?? null;
    }

    get _indicator() {
        return Main.panel.statusArea[DECK_UUID];
    }

    _scenario(name) {
        const dir = Gio.File.new_for_path(`${this._fixtures}/${name}`);
        const files = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = files.next_file(null));) {
            const fileName = info.get_name();
            // "__AGO_<seconds>__" -> an ISO timestamp that many seconds ago.
            const text = readText(`${dir.get_path()}/${fileName}`).replace(/__AGO_(\d+)__/g,
                (_m, s) => new Date(Date.now() - Number(s) * 1000).toISOString());
            writeText(`${this._mock}/${fileName}`, text);
        }
        if (name === 'down')
            writeText(`${this._mock}/down.flag`, '');
        else
            GLib.unlink(`${this._mock}/down.flag`);
    }

    async _click(actor) {
        if (!actor)
            throw new Error('click: no actor');
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        this._log(`  click ${actor.constructor.name} at ${Math.round(x + w / 2)},${Math.round(y + h / 2)} (${Math.round(w)}x${Math.round(h)}, mapped=${actor.mapped})`);
        await this._clickAt(x + w / 2, y + h / 2);
    }

    // For windows of other processes (prefs), which have no actors to aim at.
    async _clickAt(x, y) {
        const now = () => GLib.get_monotonic_time();
        this._pointer.notify_absolute_motion(now(), x, y);
        await wait(150);
        this._pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await wait(60);
        this._pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await wait(400);
    }

    // Presses the keyvals in order, then releases them in reverse (a chord).
    async _keys(keyvals) {
        if (!this._keyboard) {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            await wait(500);
        }
        const now = () => GLib.get_monotonic_time();
        for (const k of keyvals)
            this._keyboard.notify_keyval(now(), k, Clutter.KeyState.PRESSED);
        for (const k of [...keyvals].reverse())
            this._keyboard.notify_keyval(now(), k, Clutter.KeyState.RELEASED);
        await wait(300);
    }

    async _shot(name) {
        const file = Gio.File.new_for_path(`${this._out}/${name}.png`);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }

    _expect(pattern) {
        const all = readText(`${this._mock}/commands.log`);
        const fresh = all.slice(this._logOffset);
        this._logOffset = all.length;
        const ok = new RegExp(pattern, 'm').test(fresh);
        if (!ok)
            this._failures++;
        this._log(`${ok ? 'PASS' : 'FAIL'} expect /${pattern}/${ok ? '' : `\n  commands since last expect:\n${fresh.replace(/^/gm, '    ')}`}`);
    }

    async _run() {
        const plan = JSON.parse(readText(env('TUPLE_DECK_TEST_PLAN')));
        // Let the session settle and the follow streams connect.
        await wait(5000);
        Main.overview.hide();
        // A new virtual device drops its first events while the seat registers
        // it, so create it and move it around before the first real click.
        const seat = global.stage.context.get_backend().get_default_seat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        await wait(300);
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 800, 600);
        await wait(800);
        this._logOffset = readText(`${this._mock}/commands.log`).length;

        const ctx = {
            Main,
            Clutter,
            GLib,
            wait,
            readText,
            indicator: () => this._indicator,
            deck: () => this._deck,
            click: a => this._click(a),
            clickAt: (x, y) => this._clickAt(x, y),
            keys: (...keyvals) => this._keys(keyvals),
            shot: n => this._shot(n),
        };
        for (const [op, arg] of plan) {
            this._log(`> ${op} ${typeof arg === 'string' ? arg : JSON.stringify(arg)}`);
            switch (op) {
            case 'scenario':
                this._scenario(arg);
                await wait(1500);
                break;
            case 'wait':
                await wait(arg);
                break;
            case 'shot':
                await this._shot(arg);
                break;
            case 'click': {
                // eslint-disable-next-line no-new-func
                const actor = new Function('ctx', `const {indicator, deck, Main} = ctx; return (${arg});`)(ctx);
                await this._click(actor);
                break;
            }
            case 'eval': {
                // eslint-disable-next-line no-new-func
                const fn = new Function('ctx', `const {indicator, deck, Main, wait, click, clickAt, keys, shot, readText, GLib, Clutter} = ctx;
                    return (async () => { ${arg} })();`);
                const value = await fn(ctx);
                if (value !== undefined)
                    this._log(`  = ${typeof value === 'string' ? value : JSON.stringify(value)}`);
                break;
            }
            case 'expect':
                await wait(300);
                this._expect(arg);
                break;
            default:
                throw new Error(`unknown op ${op}`);
            }
        }
    }
}
