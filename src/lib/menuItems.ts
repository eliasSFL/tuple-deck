import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    type CallMember, type CaptureCall, type Contact, type OngoingCall, type Room,
    formatDuration, formatWhen, isOnline, joinNames, ongoingCallLabel, personName, roomLabel,
    roomOccupants,
} from './model.js';

/**
 * Makes `menu` (a section or submenu) show one item per entry, in order,
 * reusing items by key so an open submenu keeps its scroll position and hover
 * state while presence updates stream in.
 */
export function syncItems<T, I extends PopupMenu.PopupBaseMenuItem>(
    menu: PopupMenu.PopupMenuBase,
    items: Map<string, I>,
    entries: T[],
    {keyOf, create, update}: {
        keyOf: (entry: T) => string,
        create: (entry: T) => I,
        update: (item: I, entry: T) => void,
    },
): void {
    const keep = new Set(entries.map(keyOf));
    for (const [key, item] of items) {
        if (!keep.has(key)) {
            item.destroy();
            items.delete(key);
        }
    }
    entries.forEach((entry, index) => {
        const key = keyOf(entry);
        let item = items.get(key);
        if (!item) {
            item = create(entry);
            items.set(key, item);
            menu.addMenuItem(item, index);
        } else {
            menu.moveMenuItem(item, index);
        }
        update(item, entry);
    });
}

function iconButton(iconName: string, accessibleName: string, onClicked: () => void): St.Button {
    const button = new St.Button({
        style_class: 'tuple-deck-icon-button',
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}),
    });
    button.connect('clicked', onClicked);
    return button;
}

function setButtonIcon(button: St.Button, iconName: string) {
    (button.child as St.Icon).icon_name = iconName;
}

function twoLineLabel(): {box: St.BoxLayout, title: St.Label, subtitle: St.Label} {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const title = new St.Label({style_class: 'tuple-deck-title'});
    const subtitle = new St.Label({style_class: 'tuple-deck-dim'});
    box.add_child(title);
    box.add_child(subtitle);
    return {box, title, subtitle};
}

function setSubtitle(label: St.Label, text: string | null | undefined) {
    label.text = text ?? '';
    label.visible = !!text;
}

type Presence = 'online' | 'busy' | 'offline';

/** A presence dot: green online, amber busy, grey offline. */
function presenceDot(): St.Widget {
    return new St.Widget({style_class: 'tuple-deck-dot', y_align: Clutter.ActorAlign.CENTER});
}

function setPresence(dot: St.Widget, status: Presence) {
    for (const s of ['online', 'busy', 'offline'])
        dot.remove_style_class_name(s);
    dot.add_style_class_name(status);
}

/** Bold, non-interactive line used as a heading inside the menu. */
export class HeaderItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    private _icon: St.Icon;
    private _title: St.Label;
    private _subtitle: St.Label;

    constructor() {
        super({reactive: false, can_focus: false, style_class: 'tuple-deck-header'});
        // St marks non-reactive actors :insensitive, which the theme greys
        // out; a heading should keep the normal text colour.
        const undim = () => this.remove_style_pseudo_class('insensitive');
        undim();
        this.connect('notify::reactive', undim);
        this._icon = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._icon);
        const {box, title, subtitle} = twoLineLabel();
        this._title = title;
        this._subtitle = subtitle;
        this.add_child(box);
        this.label_actor = title;
    }

    update({title, subtitle = '', gicon = null, iconName = null}: {
        title: string, subtitle?: string, gicon?: Gio.Icon | null, iconName?: string | null,
    }) {
        this._title.text = title;
        setSubtitle(this._subtitle, subtitle);
        if (gicon)
            this._icon.gicon = gicon;
        else if (iconName)
            this._icon.icon_name = iconName;
        this._icon.visible = !!(gicon || iconName);
    }
}

/**
 * A contact: click calls them (or adds them to the current call); star toggles
 * favorite. Contacts from outside your team also get a remove button.
 */
export class ContactItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    contact!: Contact;
    private _dot: St.Widget;
    private _name: St.Label;
    private _detail: St.Label;
    private _remove: St.Button;
    private _star: St.Button;

    constructor({onActivate, onToggleFavorite, onRemove}: {
        onActivate: (contact: Contact) => void,
        onToggleFavorite: (contact: Contact) => void,
        onRemove: (contact: Contact) => void,
    }) {
        super({style_class: 'tuple-deck-row'});
        this._dot = presenceDot();
        this.add_child(this._dot);
        const {box, title, subtitle} = twoLineLabel();
        this._name = title;
        this._detail = subtitle;
        this.add_child(box);
        this.label_actor = title;
        this._remove = iconButton('list-remove-symbolic', 'Remove contact', () => onRemove(this.contact));
        this.add_child(this._remove);
        this._star = iconButton('non-starred-symbolic', 'Favorite', () => onToggleFavorite(this.contact));
        this.add_child(this._star);
        this.connect('activate', () => onActivate(this.contact));
    }

    update(contact: Contact, {inCall}: {inCall: boolean}) {
        this.contact = contact;
        this._name.text = personName(contact);
        const status = isOnline(contact) ? 'online' : contact.status === 'busy' ? 'busy' : 'offline';
        setPresence(this._dot, status);
        const parts = [];
        if (contact.status === 'busy')
            parts.push('In a call');
        if (contact.kind === 'external')
            parts.push('External');
        else if (contact.kind === 'agent')
            parts.push('Agent');
        setSubtitle(this._detail, parts.join(' · '));
        this._remove.visible = contact.kind !== 'teammate';
        setButtonIcon(this._star, contact.favorited ? 'starred-symbolic' : 'non-starred-symbolic');
        this._star.accessible_name = contact.favorited ? 'Remove from favorites' : 'Add to favorites';
        this.accessible_name = `${inCall ? 'Add' : 'Call'} ${personName(contact)}`;
    }
}

/** A room: click joins; copy puts its link on the clipboard; star toggles favorite. */
export class RoomItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    room!: Room;
    private _dot: St.Widget;
    private _name: St.Label;
    private _detail: St.Label;
    private _star: St.Button;

    constructor({onActivate, onCopy, onToggleFavorite}: {
        onActivate: (room: Room) => void,
        onCopy: (room: Room) => void,
        onToggleFavorite: (room: Room) => void,
    }) {
        super({style_class: 'tuple-deck-row'});
        this._dot = presenceDot();
        this.add_child(this._dot);
        const {box, title, subtitle} = twoLineLabel();
        this._name = title;
        this._detail = subtitle;
        this.add_child(box);
        this.label_actor = title;
        this.add_child(iconButton('edit-copy-symbolic', 'Copy room link', () => onCopy(this.room)));
        this._star = iconButton('non-starred-symbolic', 'Favorite', () => onToggleFavorite(this.room));
        this.add_child(this._star);
        this.connect('activate', () => onActivate(this.room));
    }

    update(room: Room) {
        this.room = room;
        this._name.text = roomLabel(room);
        const people = roomOccupants(room).map(personName);
        setPresence(this._dot, room.active_call ? 'online' : 'offline');
        let detail = room.kind === 'personal' ? 'Personal' : 'Team';
        if (room.active_call)
            detail = people.length ? `${people.join(', ')} inside` : 'Call in progress';
        setSubtitle(this._detail, detail);
        setButtonIcon(this._star, room.favorited ? 'starred-symbolic' : 'non-starred-symbolic');
    }
}

/** Someone on the current call; others get a remove button. */
export class ParticipantItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    participant!: CallMember;
    private _mic: St.Icon;
    private _name: St.Label;
    private _remove: St.Button;

    constructor({onRemove}: {onRemove: (participant: CallMember) => void}) {
        super({activate: false, style_class: 'tuple-deck-row'});
        this._mic = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._mic);
        this._name = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._name);
        this.label_actor = this._name;
        this._remove = iconButton('window-close-symbolic', 'Remove from call', () => onRemove(this.participant));
        this.add_child(this._remove);
    }

    update(participant: CallMember) {
        this.participant = participant;
        this._name.text = participant.isSelf ? `${participant.name} (you)` : participant.name;
        this._mic.icon_name = participant.muted
            ? 'microphone-disabled-symbolic' : 'audio-input-microphone-symbolic';
        this._mic.opacity = participant.muted === null ? 0 : 255;
        this._remove.visible = !participant.isSelf;
    }
}

/** A call in progress you can join (from `call list`). */
export class LiveCallItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    call!: OngoingCall;
    private _name: St.Label;
    private _detail: St.Label;

    constructor({onActivate}: {onActivate: (call: OngoingCall) => void}) {
        super({style_class: 'tuple-deck-row'});
        const dot = presenceDot();
        setPresence(dot, 'online');
        this.add_child(dot);
        const {box, title, subtitle} = twoLineLabel();
        this._name = title;
        this._detail = subtitle;
        this.add_child(box);
        this.label_actor = title;
        this.connect('activate', () => onActivate(this.call));
    }

    update(call: OngoingCall) {
        this.call = call;
        this._name.text = ongoingCallLabel(call);
        const parts = [];
        if (call.title && call.people.length)
            parts.push(joinNames(call.people.map(p => p.shortName)));
        if (call.startedAt)
            parts.push(formatDuration((Date.now() - call.startedAt) / 1000));
        setSubtitle(this._detail, parts.join(' · '));
        this.accessible_name = `Join ${ongoingCallLabel(call)}`;
    }
}

/** A stored call: click opens its Markdown export; the bin deletes it. */
export class HistoryItem extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    call: CaptureCall;
    private _delete: St.Button;

    constructor(call: CaptureCall, {onActivate, onDelete}: {
        onActivate: (call: CaptureCall) => void,
        onDelete: (call: CaptureCall) => void,
    }) {
        super({style_class: 'tuple-deck-row'});
        this.call = call;
        const label = new St.Label({
            text: [formatWhen(call.startedAt), call.title].filter(Boolean).join(' · '),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(label);
        this.label_actor = label;
        this._delete = iconButton('user-trash-symbolic', 'Delete this call', () => onDelete(this.call));
        this.add_child(this._delete);
        this.connect('activate', () => onActivate(this.call));
    }
}
