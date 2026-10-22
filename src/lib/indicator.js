import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ContactItem, HeaderItem, ParticipantItem, RoomItem, syncItems} from './menuItems.js';
import {
    REACTIONS, Status, callStartedAt, callTitle, callerName, formatDuration, formatWhen,
    isOnline, isSelfSharing, participantsOf, selfMuted, sharerId, sortContacts,
    sortRooms,
} from './model.js';

const REACTION_LABELS = {airhorn: 'Air horn', trombone: 'Sad trombone', flute: 'Flute'};

// Items are actors; sections are not, but expose one as .actor.
function setVisible(...pairs) {
    for (let i = 0; i < pairs.length; i += 2)
        (pairs[i].actor ?? pairs[i]).visible = !!pairs[i + 1];
}

export const TupleIndicator = GObject.registerClass(
class TupleIndicator extends PanelMenu.Button {
    _init({store, actions, settings, gicon}) {
        super._init(0.5, 'Tuple', false);
        this._store = store;
        this._actions = actions;
        this._settings = settings;
        this._gicon = gicon;
        this._timerId = 0;
        this._localCallStart = null;
        this._callKey = null;
        this._mutedGuess = false;
        this._sharingGuess = false;
        this._capturingGuess = false;
        this._guestMode = null;
        this._contactItems = new Map();
        this._roomItems = new Map();
        this._participantItems = new Map();

        this._buildPanelButton();
        this._buildMenu();

        store.connectObject('changed', () => this._sync(), this);
        settings.connectObject('changed::show-call-timer', () => this._sync(), this);
        this.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._onMenuOpened();
        }, this);
        this._sync();
    }

    destroy() {
        this._stopTimer();
        super.destroy();
    }

    // -- panel button ----------------------------------------------------------

    _buildPanelButton() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        // Tuple's icon is full colour, so status can't tint it; a small dot
        // in its corner shows ringing / in a call instead.
        const iconStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({gicon: this._gicon, style_class: 'system-status-icon'});
        this._badge = new St.Widget({
            style_class: 'tuple-deck-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            // Hang it off the corner so it doesn't cover the logo.
            translation_x: 3,
            translation_y: 2,
            visible: false,
        });
        iconStack.add_child(this._icon);
        iconStack.add_child(this._badge);
        this._micIcon = new St.Icon({
            icon_name: 'microphone-disabled-symbolic',
            style_class: 'system-status-icon',
            visible: false,
        });
        this._timerLabel = new St.Label({
            style_class: 'tuple-deck-timer',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(iconStack);
        box.add_child(this._micIcon);
        box.add_child(this._timerLabel);
        this.add_child(box);
    }

    // -- menu ----------------------------------------------------------------------

    _item(label, callback, iconName = null) {
        const item = iconName
            ? new PopupMenu.PopupImageMenuItem(label, iconName)
            : new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => callback());
        return item;
    }

    _buildMenu() {
        const menu = this.menu;
        menu.box.add_style_class_name('tuple-deck-menu');

        this._header = new HeaderItem();
        menu.addMenuItem(this._header);
        this._startItem = this._item('Start Tuple', () => this._actions.startDaemon(), 'media-playback-start-symbolic');
        menu.addMenuItem(this._startItem);
        this._loginItem = this._item('Log in…', () => this._actions.login(), 'avatar-default-symbolic');
        menu.addMenuItem(this._loginItem);
        this._updateItem = this._item('Update Tuple', () => this._actions.update(), 'software-update-available-symbolic');
        menu.addMenuItem(this._updateItem);

        // Incoming call
        this._incomingSection = new PopupMenu.PopupMenuSection();
        this._incomingHeader = new HeaderItem();
        this._incomingSection.addMenuItem(this._incomingHeader);
        this._incomingSection.addMenuItem(this._item('Answer', () =>
            this._actions.accept(this._store.call?.id), 'call-start-symbolic'));
        menu.addMenuItem(this._incomingSection);

        // Active / outgoing call
        this._callSection = new PopupMenu.PopupMenuSection();
        this._buildCallSection(this._callSection);
        menu.addMenuItem(this._callSection);

        // Not in a call
        this._idleSection = new PopupMenu.PopupMenuSection();
        this._idleSection.addMenuItem(this._item('Start a call in my room',
            () => this._actions.startInMyRoom(), 'call-start-symbolic'));
        this._idleSection.addMenuItem(this._item('Join link from clipboard',
            () => this._actions.joinFromClipboard(), 'edit-paste-symbolic'));
        menu.addMenuItem(this._idleSection);

        this._listsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(this._listsSeparator);
        this._buildContacts();
        this._buildRooms();
        this._buildHistory();
        this._buildMachines();

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._settingsItem = this._item('Settings', () => this._actions.openPreferences(), 'preferences-system-symbolic');
        menu.addMenuItem(this._settingsItem);
        this._stopItem = this._item('Stop Tuple', () => this._actions.stopDaemon(), 'system-shutdown-symbolic');
        menu.addMenuItem(this._stopItem);
        this._logoutItem = this._item('Log out', () => this._actions.logout(), 'system-log-out-symbolic');
        menu.addMenuItem(this._logoutItem);
    }

    _buildCallSection(section) {
        this._callHeader = new HeaderItem();
        section.addMenuItem(this._callHeader);

        this._muteSwitch = new PopupMenu.PopupSwitchMenuItem('Mute microphone', false);
        this._muteSwitch.connect('toggled', async (_item, state) => {
            this._mutedGuess = state;
            this._syncPanel();
            const result = await this._actions.setMuted(state);
            if (!result.ok) {
                this._mutedGuess = !state;
                this._sync();
            }
        });
        section.addMenuItem(this._muteSwitch);

        this._shareSwitch = new PopupMenu.PopupSwitchMenuItem('Share my screen', false);
        this._shareSwitch.connect('toggled', async (_item, state) => {
            this._sharingGuess = state;
            const result = await this._actions.setSharing(state);
            if (!result.ok) {
                this._sharingGuess = !state;
                this._sync();
            }
        });
        section.addMenuItem(this._shareSwitch);

        this._controlSwitch = new PopupMenu.PopupSwitchMenuItem('Control their screen', false);
        this._controlSwitch.connect('toggled', async (_item, state) => {
            const mode = state ? 'control' : 'annotation';
            const result = await this._actions.setSetting('guest-mode', mode);
            this._guestMode = result.ok ? mode : this._guestMode;
            this._sync();
        });
        section.addMenuItem(this._controlSwitch);

        this._participantsSub = new PopupMenu.PopupSubMenuMenuItem('Participants', true);
        this._participantsSub.icon.icon_name = 'system-users-symbolic';
        section.addMenuItem(this._participantsSub);

        // Less frequent call actions live in one submenu to keep the menu
        // short enough for a laptop screen.
        this._moreSub = new PopupMenu.PopupSubMenuMenuItem('Reactions & more', true);
        this._moreSub.icon.icon_name = 'face-smile-big-symbolic';
        for (const sound of REACTIONS)
            this._moreSub.menu.addMenuItem(this._item(REACTION_LABELS[sound] ?? sound, () => this._actions.react(sound)));
        this._moreSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._snapshotItem = this._item('Save screenshot of shared screen',
            () => this._actions.snapshot(), 'camera-photo-symbolic');
        this._moreSub.menu.addMenuItem(this._snapshotItem);
        this._captureSwitch = new PopupMenu.PopupSwitchMenuItem('Capture transcript', false);
        this._captureSwitch.connect('toggled', async (_item, state) => {
            this._capturingGuess = state;
            const result = await this._actions.setCapturing(state);
            if (!result.ok) {
                this._capturingGuess = !state;
                this._sync();
            }
        });
        this._moreSub.menu.addMenuItem(this._captureSwitch);
        section.addMenuItem(this._moreSub);

        this._leaveItem = this._item('Leave call', () => this._actions.leave(), 'call-stop-symbolic');
        this._leaveItem.add_style_class_name('tuple-deck-destructive');
        section.addMenuItem(this._leaveItem);
    }

    _buildContacts() {
        this._contactsSub = new PopupMenu.PopupSubMenuMenuItem('Contacts', true);
        this._contactsSub.icon.icon_name = 'avatar-default-symbolic';
        this._contactsList = new PopupMenu.PopupMenuSection();
        this._contactsSub.menu.addMenuItem(this._contactsList);
        this._contactsEmpty = new PopupMenu.PopupMenuItem('No contacts yet', {reactive: false});
        this._contactsSub.menu.addMenuItem(this._contactsEmpty);
        this.menu.addMenuItem(this._contactsSub);
    }

    _buildRooms() {
        this._roomsSub = new PopupMenu.PopupSubMenuMenuItem('Rooms', true);
        this._roomsSub.icon.icon_name = 'user-home-symbolic';
        this._roomsList = new PopupMenu.PopupMenuSection();
        this._roomsSub.menu.addMenuItem(this._roomsList);
        this._roomsSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._roomsSub.menu.addMenuItem(this._item('New team room…', () => this._actions.createRoom(), 'list-add-symbolic'));
        this.menu.addMenuItem(this._roomsSub);
    }

    _buildHistory() {
        this._historySub = new PopupMenu.PopupSubMenuMenuItem('Recent calls', true);
        this._historySub.icon.icon_name = 'document-open-recent-symbolic';
        this._historyList = new PopupMenu.PopupMenuSection();
        this._historySub.menu.addMenuItem(this._historyList);
        this._historySub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._historySub.menu.addMenuItem(this._item('Search calls…', () => this._actions.openSearch(), 'edit-find-symbolic'));
        this._historySub.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._loadHistory();
        }, this);
        this.menu.addMenuItem(this._historySub);
    }

    _buildMachines() {
        this._machinesSub = new PopupMenu.PopupSubMenuMenuItem('My other machines', true);
        this._machinesSub.icon.icon_name = 'computer-symbolic';
        this._machinesSub.visible = false;
        this.menu.addMenuItem(this._machinesSub);
    }

    // -- lazy loads (on menu / submenu open) ------------------------------------------

    async _onMenuOpened() {
        const status = this._store.status;
        if (status === Status.DOWN || status === Status.SIGNED_OUT)
            return;
        const [machines, settings] = await Promise.all([
            this._actions.machines(),
            this._store.has('settings') ? this._actions.getSettings() : Promise.resolve([]),
        ]);
        this._machines = machines;
        this._machinesSub.menu.removeAll();
        for (const m of machines)
            this._machinesSub.menu.addMenuItem(this._item(m.name, () => this._actions.callMachine(m)));
        const guest = settings.find(s => s.name === 'guest-mode');
        this._guestMode = guest ? guest.value : null;
        this._sync();
    }

    async _loadHistory() {
        this._historyList.removeAll();
        this._historyList.addMenuItem(new PopupMenu.PopupMenuItem('Loading…', {reactive: false}));
        const {calls, error} = await this._actions.recentCalls();
        this._historyList.removeAll();
        if (error || !calls.length) {
            const item = new PopupMenu.PopupMenuItem(error || 'No captured calls yet', {reactive: false});
            item.label.clutter_text.line_wrap = true;
            item.add_style_class_name('tuple-deck-note');
            this._historyList.addMenuItem(item);
            return;
        }
        for (const call of calls) {
            const label = [formatWhen(call.startedAt), call.title].filter(Boolean).join(' · ');
            this._historyList.addMenuItem(this._item(label, () => this._actions.openCall(call.id)));
        }
    }

    // -- sync --------------------------------------------------------------------------

    _sync() {
        const store = this._store;
        const status = store.status;
        const state = store.state;
        const call = store.call;
        const selfId = store.selfId;
        const ready = status !== Status.DOWN && status !== Status.SIGNED_OUT;
        const inCall = status === Status.IN_CALL || status === Status.OUTGOING;

        // Reset optimistic switch state whenever a different call starts.
        const callKey = inCall ? String(call?.id ?? 'call') : null;
        if (callKey !== this._callKey) {
            this._callKey = callKey;
            this._localCallStart = callKey ? Date.now() : null;
            this._mutedGuess = false;
            this._sharingGuess = false;
            this._capturingGuess = false;
        }

        this._syncHeader(status, state);
        setVisible(
            this._startItem, status === Status.DOWN,
            this._loginItem, status === Status.SIGNED_OUT,
            this._updateItem, ready && !!store.updateVersion,
            this._incomingSection, status === Status.INCOMING,
            this._callSection, inCall,
            this._idleSection, status === Status.IDLE || status === Status.OFFLINE,
            this._listsSeparator, ready,
            this._contactsSub, ready,
            this._roomsSub, ready,
            this._historySub, ready && store.has('capture'),
            this._machinesSub, ready && !inCall && this._machines?.length,
            this._stopItem, status !== Status.DOWN,
            this._logoutItem, ready,
        );
        if (store.updateVersion)
            this._updateItem.label.text = `Update Tuple to ${store.updateVersion}`;

        if (status === Status.INCOMING) {
            this._incomingHeader.update({
                title: `${callerName(call, selfId)} is calling`,
                subtitle: call?.title ?? '',
                iconName: 'call-incoming-symbolic',
            });
        }
        if (inCall)
            this._syncCall(status, call, selfId);
        if (ready) {
            this._syncContacts(inCall);
            this._syncRooms();
        }
        this._syncPanel();
        this._syncTimer(inCall);
    }

    _syncHeader(status, state) {
        const user = state?.user;
        const name = user?.full_name || user?.short_name || user?.email || 'Tuple';
        const version = state?.app_version ?? '';
        switch (status) {
        case Status.DOWN:
            this._header.update({
                title: "Tuple isn't running",
                subtitle: this._store.error && !/not reachable|lost connection/i.test(this._store.error)
                    ? this._store.error : 'Start it to receive calls',
                iconName: 'network-offline-symbolic',
            });
            break;
        case Status.SIGNED_OUT:
            this._header.update({title: 'Not logged in', subtitle: version, gicon: this._gicon});
            break;
        case Status.OFFLINE:
            this._header.update({
                title: name,
                subtitle: `Reconnecting to Tuple… (${state?.connection?.websocket_state ?? 'offline'})`,
                iconName: 'network-offline-symbolic',
            });
            break;
        default: {
            const online = state?.contacts?.online ?? 0;
            this._header.update({
                title: name,
                subtitle: [`${online} online`, version].filter(Boolean).join(' · '),
                gicon: this._gicon,
            });
        }
        }
    }

    _syncCall(status, call, selfId) {
        const outgoing = status === Status.OUTGOING;
        const participants = participantsOf(call, selfId);
        const others = participants.filter(p => !p.isSelf);
        this._callHeader.update({
            title: outgoing ? `Calling ${others.map(p => p.shortName).join(', ') || '…'}` : callTitle(call, selfId),
            subtitle: outgoing ? 'Ringing…' : this._callSubtitle(call),
            iconName: outgoing ? 'call-outgoing-symbolic' : 'call-start-symbolic',
        });
        this._leaveItem.label.text = outgoing ? 'Cancel call' : 'Leave call';

        const muted = selfMuted(call, selfId) ?? this._mutedGuess;
        this._muteSwitch.setToggleState(muted);

        // Without a sharer field we can't tell who's sharing; fall back to
        // what the switches last did and show everything.
        const sharerKnown = call && 'sharer_user_id' in call;
        const sharing = sharerKnown ? isSelfSharing(call, selfId) : this._sharingGuess;
        const someoneElseSharing = sharerKnown ? sharerId(call) !== null && !sharing : true;
        this._shareSwitch.setToggleState(sharing);
        this._controlSwitch.setToggleState(this._guestMode === 'control');

        const captureKnown = call && typeof (call.transcribing ?? call.recorded) === 'boolean';
        this._captureSwitch.setToggleState(captureKnown ? !!(call.transcribing ?? call.recorded) : this._capturingGuess);

        setVisible(
            this._muteSwitch, !outgoing,
            this._shareSwitch, !outgoing && this._store.has('share'),
            this._controlSwitch, !outgoing && this._guestMode !== null && someoneElseSharing,
            this._captureSwitch, !outgoing && this._store.has('capture'),
            this._participantsSub, !outgoing && participants.length,
            this._moreSub, !outgoing,
            this._snapshotItem, !outgoing && (sharerKnown ? sharerId(call) !== null : true),
        );

        this._participantsSub.label.text = `Participants (${participants.length})`;
        syncItems(this._participantsSub.menu, this._participantItems, participants, {
            keyOf: p => p.key,
            create: () => new ParticipantItem({onRemove: p => this._actions.removeParticipant(p)}),
            update: (item, p) => item.update(p),
        });
    }

    _callSubtitle(call) {
        const parts = [];
        const started = this._callStart(call);
        if (started)
            parts.push(formatDuration((Date.now() - started) / 1000));
        if (call?.summary)
            parts.push(call.summary);
        return parts.join(' · ');
    }

    _callStart(call) {
        return callStartedAt(call) ?? this._localCallStart;
    }

    _syncContacts(inCall) {
        const inCallIds = new Set(participantsOf(this._store.call, this._store.selfId).map(p => String(p.id)));
        const contacts = sortContacts(this._store.contacts)
            .filter(c => !inCall || !inCallIds.has(String(c.id)));
        const online = this._store.contacts.filter(isOnline).length;
        this._contactsSub.label.text = inCall
            ? 'Add someone to the call' : `Contacts${online ? ` · ${online} online` : ''}`;
        this._contactsEmpty.visible = contacts.length === 0;
        syncItems(this._contactsList, this._contactItems, contacts, {
            keyOf: c => String(c.id ?? c.email),
            create: () => new ContactItem({
                onActivate: c => (this._inCallNow() ? this._actions.addParticipant(c) : this._actions.callContact(c)),
                onToggleFavorite: c => this._actions.toggleContactFavorite(c),
            }),
            update: (item, c) => item.update(c, {inCall}),
        });
    }

    _inCallNow() {
        const s = this._store.status;
        return s === Status.IN_CALL || s === Status.OUTGOING;
    }

    _syncRooms() {
        const rooms = sortRooms(this._store.rooms);
        const occupied = rooms.filter(r => r.active_call).length;
        this._roomsSub.label.text = `Rooms${occupied ? ` · ${occupied} active` : ''}`;
        syncItems(this._roomsList, this._roomItems, rooms, {
            keyOf: r => r.slug,
            create: () => new RoomItem({
                onActivate: r => this._actions.joinRoom(r),
                onCopy: r => this._actions.copyText(r.http_value, 'Room link'),
                onToggleFavorite: r => this._actions.toggleRoomFavorite(r),
            }),
            update: (item, r) => item.update(r),
        });
    }

    _syncPanel() {
        const status = this._store.status;
        const call = this._store.call;
        const inCall = status === Status.IN_CALL;
        const inactive = status === Status.DOWN || status === Status.SIGNED_OUT || status === Status.OFFLINE;
        this._icon.opacity = inactive ? 110 : 255;

        const ringing = status === Status.INCOMING || status === Status.OUTGOING;
        this._badge.visible = ringing || inCall;
        this._badge.remove_style_class_name('ringing');
        this._badge.remove_style_class_name('live');
        this._badge.add_style_class_name(ringing ? 'ringing' : 'live');

        const muted = inCall && (selfMuted(call, this._store.selfId) ?? this._mutedGuess);
        this._micIcon.visible = !!muted;
        this.accessible_name = status === Status.INCOMING
            ? `Tuple: ${callerName(call, this._store.selfId)} is calling` : `Tuple: ${status}`;
    }

    _syncTimer(inCall) {
        const show = inCall && this._store.status === Status.IN_CALL && this._settings.get_boolean('show-call-timer');
        this._timerLabel.visible = show;
        if (inCall && !this._timerId) {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!inCall) {
            this._stopTimer();
        }
        this._tick();
    }

    _tick() {
        const call = this._store.call;
        const started = this._callStart(call);
        if (started && this._timerLabel.visible)
            this._timerLabel.text = formatDuration((Date.now() - started) / 1000);
        if (this._store.status === Status.IN_CALL && this.menu.isOpen) {
            this._callHeader.update({
                title: callTitle(call, this._store.selfId),
                subtitle: this._callSubtitle(call),
                iconName: 'call-start-symbolic',
            });
        }
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
});
