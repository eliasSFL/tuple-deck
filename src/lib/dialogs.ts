import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {type SearchHit, formatWhen} from './model.js';

function makeEntry(hint: string, text = ''): St.Entry {
    return new St.Entry({
        style_class: 'tuple-deck-entry',
        hint_text: hint,
        text,
        can_focus: true,
        x_expand: true,
    });
}

/** Resolves with the trimmed text, or null when cancelled or left empty. */
export function promptText({title, description = '', hint = '', okLabel = 'OK', initial = ''}: {
    title: string, description?: string, hint?: string, okLabel?: string, initial?: string,
}): Promise<string | null> {
    return new Promise(resolve => {
        const dialog = new ModalDialog.ModalDialog({styleClass: 'tuple-deck-dialog'});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        const entry = makeEntry(hint, initial);
        dialog.contentLayout.add_child(entry);
        dialog.setInitialKeyFocus(entry);

        let result: string | null = null;
        let done = false;
        const finish = (value: string | null) => {
            if (done)
                return;
            done = true;
            result = value;
            dialog.close();
        };
        dialog.connect('closed', () => resolve(result));
        entry.clutter_text.connect('activate', () => finish(entry.get_text().trim() || null));
        dialog.setButtons([
            {label: 'Cancel', action: () => finish(null), key: Clutter.KEY_Escape},
            {label: okLabel, action: () => finish(entry.get_text().trim() || null), default: true},
        ]);
        dialog.open();
    });
}

export function confirm({title, description = '', okLabel = 'OK', destructive = false}: {
    title: string, description?: string, okLabel?: string, destructive?: boolean,
}): Promise<boolean> {
    return new Promise(resolve => {
        const dialog = new ModalDialog.ModalDialog({styleClass: 'tuple-deck-dialog'});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
        let result = false;
        let done = false;
        const finish = (value: boolean) => {
            if (done)
                return;
            done = true;
            result = value;
            dialog.close();
        };
        dialog.connect('closed', () => resolve(result));
        dialog.setButtons([
            {label: 'Cancel', action: () => finish(false), key: Clutter.KEY_Escape},
            {label: okLabel, action: () => finish(true), default: true},
        ]);
        if (destructive)
            (dialog.buttonLayout.get_last_child() as St.Widget | null)?.add_style_class_name('destructive-action');
        dialog.open();
    });
}

/**
 * Second half of `tuple login`: shows the link it printed and collects the
 * code the browser hands back. Resolves with the code, or null.
 */
export function promptLoginCode({url, rawOutput, openUri, copyText}: {
    url: string | null,
    rawOutput: string,
    openUri: (uri: string) => void,
    copyText: (text: string) => void,
}): Promise<string | null> {
    return new Promise(resolve => {
        const dialog = new ModalDialog.ModalDialog({styleClass: 'tuple-deck-dialog'});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: 'Log in to Tuple',
            description: url
                ? 'Open the link, sign in, then paste the code Tuple shows you.'
                : 'Tuple printed no login link. Its output is below.',
        }));

        const shown = new St.Label({
            style_class: 'tuple-deck-mono',
            text: url ?? rawOutput ?? '',
            reactive: true,
        });
        shown.clutter_text.selectable = true;
        shown.clutter_text.line_wrap = true;
        dialog.contentLayout.add_child(shown);

        const entry = makeEntry('Auth code');
        dialog.contentLayout.add_child(entry);
        dialog.setInitialKeyFocus(entry);

        let result: string | null = null;
        let done = false;
        const finish = (value: string | null) => {
            if (done)
                return;
            done = true;
            result = value;
            dialog.close();
        };
        dialog.connect('closed', () => resolve(result));
        entry.clutter_text.connect('activate', () => finish(entry.get_text().trim() || null));
        const buttons: Dialog.ButtonInfo[] = [{label: 'Cancel', action: () => finish(null), key: Clutter.KEY_Escape}];
        if (url) {
            buttons.push({label: 'Copy link', action: () => copyText(url)});
            buttons.push({label: 'Open link', action: () => openUri(url)});
        }
        buttons.push({label: 'Authorize', action: () => finish(entry.get_text().trim() || null), default: true});
        dialog.setButtons(buttons);
        dialog.open();
    });
}

class HitRow extends St.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(hit: SearchHit, onPick: (hit: SearchHit) => void) {
        super({
            style_class: 'tuple-deck-hit',
            can_focus: true,
            x_expand: true,
            reactive: true,
        });
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const meta = [formatWhen(hit.at), hit.speaker].filter(Boolean).join(' · ');
        box.add_child(new St.Label({text: meta || `Call ${hit.callId.slice(0, 8)}`, style_class: 'tuple-deck-dim'}));
        const text = new St.Label({text: hit.text || '(no text)', x_expand: true});
        text.clutter_text.line_wrap = true;
        box.add_child(text);
        this.set_child(box);
        this.connect('clicked', () => onPick(hit));
    }
}

/**
 * Searches stored call captures. `search(query)` resolves with
 * {hits, error}; picking a hit calls `onPick(hit)` and closes the dialog.
 */
export function openSearchDialog({search, onPick}: {
    search: (query: string) => Promise<{hits: SearchHit[], error: string}>,
    onPick: (hit: SearchHit) => void,
}): void {
    const dialog = new ModalDialog.ModalDialog({styleClass: 'tuple-deck-dialog tuple-deck-search'});
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
        title: 'Search calls',
        description: 'Searches what was said and what was on screen. "Quoted phrases", OR and NOT work.',
    }));
    const entry = makeEntry('Search transcripts and shared screens');
    dialog.contentLayout.add_child(entry);
    const list = new Dialog.ListSection({});
    dialog.contentLayout.add_child(list);
    dialog.setInitialKeyFocus(entry);

    const setMessage = (text: string) => {
        list.list.destroy_all_children();
        list.list.add_child(new St.Label({text, style_class: 'tuple-deck-dim'}));
    };

    let generation = 0;
    let closed = false;
    dialog.connect('closed', () => {
        closed = true;
    });
    const run = async () => {
        const query = entry.get_text().trim();
        if (!query)
            return;
        const mine = ++generation;
        setMessage('Searching…');
        const {hits, error} = await search(query);
        if (mine !== generation || closed)
            return;
        if (error) {
            setMessage(error);
            return;
        }
        if (!hits.length) {
            setMessage('No matches.');
            return;
        }
        list.list.destroy_all_children();
        for (const hit of hits) {
            list.list.add_child(new HitRow(hit, picked => {
                dialog.close();
                onPick(picked);
            }));
        }
    };
    entry.clutter_text.connect('activate', () => run());
    dialog.setButtons([
        {label: 'Close', action: () => dialog.close(), key: Clutter.KEY_Escape},
        {label: 'Search', action: () => run(), default: true},
    ]);
    dialog.open();
}
