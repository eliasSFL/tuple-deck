import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    ContactItem, HeaderItem, HistoryItem, LiveCallItem, ParticipantItem, ReactionRowItem, RoomItem,
    syncItems,
} from './menuItems.js';
import {
    type Call, type Id, type Machine, type OngoingCall, type Reactions, type TupleState,
    Status, callStartedAt, callTitle, callerName, formatDuration, isOnline,
    isSelfSharing, participantsOf, reactionLabel, selfMuted, sharerId, sortContacts, sortRooms,
} from './model.js';
import type {Actions} from './actions.js';
import type {TupleStore} from './store.js';

type LabelItem = PopupMenu.PopupMenuItem | PopupMenu.PopupImageMenuItem;
type Showable = Clutter.Actor | PopupMenu.PopupMenuSection;

// Items are actors; sections are not, but expose one as .actor.
function setVisible(...pairs: Array<Showable | unknown>) {
    for (let i = 0; i < pairs.length; i += 2) {
        const target = pairs[i] as Showable & {actor?: Clutter.Actor};
        (target.actor ?? target as Clutter.Actor).visible = !!pairs[i + 1];
    }
}

export class TupleIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    // Created with a menu (dontCreateMenu = false), never the dummy one.
    declare menu: PopupMenu.PopupMenu;

    private _store: TupleStore;
    private _actions: Actions;
    private _settings: Gio.Settings;
    private _gicon: Gio.Icon;
    private _timerId: number;
    private _localCallStart: number | null;
    private _callKey: string | null;
    private _mutedGuess: boolean;
    private _sharingGuess: boolean;
    private _webcamGuess: boolean;
    private _capturingGuess: boolean;
    private _handGuess: boolean;
    private _reactionsKey: string | null;
    private _guestMode: string | null;
    // True while _setSwitch() changes a switch, so its 'toggled' handler can tell that from a click.
    private _settingSwitch = false;
    private _contactItems: Map<string, ContactItem>;
    private _roomItems: Map<string, RoomItem>;
    private _participantItems: Map<string, ParticipantItem>;
    private _liveCallItems: Map<string, LiveCallItem>;
    private _liveCalls: OngoingCall[];
    private _machines: Machine[] = [];

    // Built by _buildPanelButton() / _buildMenu() from the constructor.
    private _icon!: St.Icon;
    private _badge!: St.Widget;
    private _micIcon!: St.Icon;
    private _timerLabel!: St.Label;
    private _header!: HeaderItem;
    private _startItem!: LabelItem;
    private _loginItem!: LabelItem;
    private _updateItem!: LabelItem;
    private _settingsItem!: LabelItem;
    private _stopItem!: LabelItem;
    private _logoutItem!: LabelItem;
    private _incomingSection!: PopupMenu.PopupMenuSection;
    private _incomingHeader!: HeaderItem;
    private _callSection!: PopupMenu.PopupMenuSection;
    private _idleSection!: PopupMenu.PopupMenuSection;
    private _listsSeparator!: PopupMenu.PopupSeparatorMenuItem;
    private _callHeader!: HeaderItem;
    private _muteSwitch!: PopupMenu.PopupSwitchMenuItem;
    private _shareSwitch!: PopupMenu.PopupSwitchMenuItem;
    private _controlSwitch!: PopupMenu.PopupSwitchMenuItem;
    private _webcamSwitch!: PopupMenu.PopupSwitchMenuItem;
    private _handSwitch!: PopupMenu.PopupSwitchMenuItem;
    private _reactionsSection!: PopupMenu.PopupMenuSection;
    private _captureSwitch!: PopupMenu.PopupSwitchMenuItem;
    private _participantsSub!: PopupMenu.PopupSubMenuMenuItem;
    private _moreSub!: PopupMenu.PopupSubMenuMenuItem;
    private _snapshotItem!: LabelItem;
    private _leaveItem!: LabelItem;
    private _liveCallsSub!: PopupMenu.PopupSubMenuMenuItem;
    private _liveCallsList!: PopupMenu.PopupMenuSection;
    private _liveCallsEmpty!: PopupMenu.PopupMenuItem;
    private _contactsSub!: PopupMenu.PopupSubMenuMenuItem;
    private _contactsList!: PopupMenu.PopupMenuSection;
    private _contactsEmpty!: PopupMenu.PopupMenuItem;
    private _roomsSub!: PopupMenu.PopupSubMenuMenuItem;
    private _roomsList!: PopupMenu.PopupMenuSection;
    private _historySub!: PopupMenu.PopupSubMenuMenuItem;
    private _historyList!: PopupMenu.PopupMenuSection;
    private _machinesSub!: PopupMenu.PopupSubMenuMenuItem;

    constructor({store, actions, settings, gicon}: {
        store: TupleStore, actions: Actions, settings: Gio.Settings, gicon: Gio.Icon,
    }) {
        super(0.5, 'Tuple', false);
        this._store = store;
        this._actions = actions;
        this._settings = settings;
        this._gicon = gicon;
        this._timerId = 0;
        this._localCallStart = null;
        this._callKey = null;
        this._mutedGuess = false;
        this._sharingGuess = false;
        this._webcamGuess = false;
        this._capturingGuess = false;
        this._handGuess = false;
        this._reactionsKey = null;
        this._guestMode = null;
        this._contactItems = new Map();
        this._roomItems = new Map();
        this._participantItems = new Map();
        this._liveCallItems = new Map();
        this._liveCalls = [];

        this._buildPanelButton();
        this._buildMenu();

        store.connectObject('changed', () => this._sync(), this);
        settings.connectObject('changed::show-call-timer', () => this._sync(), this);
        this.menu.connectObject('open-state-changed', (_m: unknown, open: boolean) => {
            if (open)
                this._onMenuOpened();
        }, this);
        this._sync();
    }

    override destroy() {
        this._stopTimer();
        super.destroy();
    }

    // -- panel button ----------------------------------------------------------

    private _buildPanelButton() {
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

    private _item(label: string, callback: () => void, iconName: string | null = null): LabelItem {
        const item = iconName
            ? new PopupMenu.PopupImageMenuItem(label, iconName)
            : new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => callback());
        return item;
    }

    private _buildMenu() {
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
        this._buildLiveCalls();
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

    private _buildCallSection(section: PopupMenu.PopupMenuSection) {
        this._callHeader = new HeaderItem();
        section.addMenuItem(this._callHeader);

        this._muteSwitch = new PopupMenu.PopupSwitchMenuItem('Mute microphone', false);
        this._onToggle(this._muteSwitch, async state => {
            this._mutedGuess = state;
            this._syncPanel();
            const result = await this._actions.setMuted(state);
            if (!result.ok) {
                this._mutedGuess = !state;
                this._sync();
            }
        });
        section.addMenuItem(this._muteSwitch);

        // Turning these on only opens a picker (the portal's, or Tuple's camera
        // picker), so the switches show what Tuple's log says is shared, not
        // what was clicked; see TupleStore.media.
        this._shareSwitch = this._mediaSwitch('Share my screen', on => this._actions.setSharing(on),
            guess => (this._sharingGuess = guess));
        section.addMenuItem(this._shareSwitch);
        this._webcamSwitch = this._mediaSwitch('Share my webcam', on => this._actions.setWebcam(on),
            guess => (this._webcamGuess = guess));
        section.addMenuItem(this._webcamSwitch);

        this._controlSwitch = new PopupMenu.PopupSwitchMenuItem('Control their screen', false);
        this._onToggle(this._controlSwitch, async state => {
            const mode = state ? 'control' : 'annotation';
            const result = await this._actions.setSetting('guest-mode', mode);
            this._guestMode = result.ok ? mode : this._guestMode;
            this._sync();
        });
        section.addMenuItem(this._controlSwitch);

        this._participantsSub = new PopupMenu.PopupSubMenuMenuItem('Participants', true);
        this._participantsSub.icon!.icon_name = 'system-users-symbolic';
        section.addMenuItem(this._participantsSub);

        // Less frequent call actions live in one submenu to keep the menu
        // short enough for a laptop screen.
        this._moreSub = new PopupMenu.PopupSubMenuMenuItem('Reactions & more', true);
        this._moreSub.icon!.icon_name = 'face-smile-big-symbolic';
        // Filled from `tuple call react --help` by _syncReactions().
        this._reactionsSection = new PopupMenu.PopupMenuSection();
        this._moreSub.menu.addMenuItem(this._reactionsSection);
        this._moreSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // The CLI doesn't report a raised hand, so this remembers what you clicked.
        this._handSwitch = new PopupMenu.PopupSwitchMenuItem('Raise hand', false);
        this._onToggle(this._handSwitch, async state => {
            this._handGuess = state;
            const result = await this._actions.setHandRaised(state);
            if (!result.ok) {
                this._handGuess = !state;
                this._sync();
            }
        });
        this._moreSub.menu.addMenuItem(this._handSwitch);
        this._snapshotItem = this._item('Save screenshot of shared screen',
            () => this._actions.snapshot(), 'camera-photo-symbolic');
        this._moreSub.menu.addMenuItem(this._snapshotItem);
        this._captureSwitch = new PopupMenu.PopupSwitchMenuItem('Capture transcript', false);
        this._onToggle(this._captureSwitch, async state => {
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

    private _buildLiveCalls() {
        this._liveCallsSub = new PopupMenu.PopupSubMenuMenuItem('Live calls', true);
        this._liveCallsSub.icon!.icon_name = 'call-start-symbolic';
        this._liveCallsList = new PopupMenu.PopupMenuSection();
        this._liveCallsSub.menu.addMenuItem(this._liveCallsList);
        this._liveCallsEmpty = new PopupMenu.PopupMenuItem('No live calls', {reactive: false});
        this._liveCallsSub.menu.addMenuItem(this._liveCallsEmpty);
        this.menu.addMenuItem(this._liveCallsSub);
    }

    private _buildContacts() {
        this._contactsSub = new PopupMenu.PopupSubMenuMenuItem('Contacts', true);
        this._contactsSub.icon!.icon_name = 'avatar-default-symbolic';
        this._contactsList = new PopupMenu.PopupMenuSection();
        this._contactsSub.menu.addMenuItem(this._contactsList);
        this._contactsEmpty = new PopupMenu.PopupMenuItem('No contacts yet', {reactive: false});
        this._contactsSub.menu.addMenuItem(this._contactsEmpty);
        this._contactsSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._contactsSub.menu.addMenuItem(this._item('Invite someone to Tuple…',
            () => this._actions.inviteContact(), 'mail-send-symbolic'));
        this.menu.addMenuItem(this._contactsSub);
    }

    private _buildRooms() {
        this._roomsSub = new PopupMenu.PopupSubMenuMenuItem('Rooms', true);
        this._roomsSub.icon!.icon_name = 'user-home-symbolic';
        this._roomsList = new PopupMenu.PopupMenuSection();
        this._roomsSub.menu.addMenuItem(this._roomsList);
        this._roomsSub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._roomsSub.menu.addMenuItem(this._item('New team room…', () => this._actions.createRoom(), 'list-add-symbolic'));
        this.menu.addMenuItem(this._roomsSub);
    }

    private _buildHistory() {
        this._historySub = new PopupMenu.PopupSubMenuMenuItem('Recent calls', true);
        this._historySub.icon!.icon_name = 'document-open-recent-symbolic';
        this._historyList = new PopupMenu.PopupMenuSection();
        this._historySub.menu.addMenuItem(this._historyList);
        this._historySub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._historySub.menu.addMenuItem(this._item('Search calls…', () => this._actions.openSearch(), 'edit-find-symbolic'));
        this._historySub.menu.connectObject('open-state-changed', (_m: unknown, open: boolean) => {
            if (open)
                this._loadHistory();
        }, this);
        this.menu.addMenuItem(this._historySub);
    }

    private _buildMachines() {
        this._machinesSub = new PopupMenu.PopupSubMenuMenuItem('My other machines', true);
        this._machinesSub.icon!.icon_name = 'computer-symbolic';
        this._machinesSub.visible = false;
        this.menu.addMenuItem(this._machinesSub);
    }

    // -- lazy loads (on menu / submenu open) ------------------------------------------

    private async _onMenuOpened() {
        const status = this._store.status;
        if (status === Status.DOWN || status === Status.SIGNED_OUT)
            return;
        const [machines, settings, liveCalls] = await Promise.all([
            this._actions.machines(),
            this._store.has('settings') ? this._actions.getSettings() : Promise.resolve([]),
            this._actions.ongoingCalls(),
        ]);
        this._liveCalls = liveCalls;
        this._machines = machines;
        this._machinesSub.menu.removeAll();
        for (const m of machines)
            this._machinesSub.menu.addMenuItem(this._item(m.name, () => this._actions.callMachine(m)));
        const guest = settings.find(s => s.name === 'guest-mode');
        this._guestMode = guest ? guest.value : null;
        this._sync();
    }

    private async _loadHistory() {
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
            this._historyList.addMenuItem(new HistoryItem(call, {
                onActivate: c => this._actions.openCall(c.id),
                onDelete: async c => {
                    if (await this._actions.deleteCapture(c))
                        this._loadHistory();
                },
            }));
        }
    }

    // -- sync --------------------------------------------------------------------------

    private _sync() {
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
            this._webcamGuess = false;
            this._capturingGuess = false;
            this._handGuess = false;
        }

        // `call list` may include the call you are already on.
        const liveCalls = this._liveCalls.filter(c => !call || c.id !== String(call.id));

        this._syncHeader(status, state);
        setVisible(
            this._startItem, status === Status.DOWN,
            this._loginItem, status === Status.SIGNED_OUT,
            this._updateItem, ready && !!store.updateVersion,
            this._incomingSection, status === Status.INCOMING,
            this._callSection, inCall,
            this._idleSection, status === Status.IDLE || status === Status.OFFLINE,
            this._listsSeparator, ready,
            this._liveCallsSub, ready,
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
            this._syncLiveCalls(liveCalls);
            this._syncContacts(inCall);
            this._syncRooms();
        }
        this._syncPanel();
        this._syncTimer(inCall);
    }

    private _syncHeader(status: Status, state: TupleState | null) {
        const user = {...state?.user, ...this._store.identity};
        const name = user.full_name || user.short_name || user.email || 'Tuple';
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
                subtitle: [user.email, `${online} online`, version].filter(Boolean).join(' · '),
                gicon: this._gicon,
            });
        }
        }
    }

    private _syncCall(status: Status, call: Call | null, selfId: Id | null) {
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
        this._setSwitch(this._muteSwitch, muted);

        // Tuple doesn't report who's sharing (state has no sharer field, even
        // while you share), so offer the sharer-only items unless it ever does.
        const sharerKnown = call && 'sharer_user_id' in call;
        const someoneElseSharing = sharerKnown ? sharerId(call) !== null && !isSelfSharing(call, selfId) : true;
        const media = this._store.media;
        this._setSwitch(this._shareSwitch, media?.screen ?? this._sharingGuess);
        this._setSwitch(this._webcamSwitch, media?.webcam ?? this._webcamGuess);
        this._setSwitch(this._controlSwitch, this._guestMode === 'control');

        const captureKnown = call && typeof (call.transcribing ?? call.recorded) === 'boolean';
        this._setSwitch(this._captureSwitch, captureKnown ? !!(call.transcribing ?? call.recorded) : this._capturingGuess);
        this._setSwitch(this._handSwitch, this._handGuess);
        this._syncReactions(this._store.reactions);

        setVisible(
            this._muteSwitch, !outgoing,
            this._shareSwitch, !outgoing && this._store.has('share'),
            this._webcamSwitch, !outgoing && this._store.has('webcam'),
            this._handSwitch, !outgoing && this._store.has('call raise-hand') && this._store.has('call lower-hand'),
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

    /**
     * Runs `handler` when the user flips `item`. In GNOME 51, setting a switch
     * from code (setToggleState) emits 'toggled' too, which would rerun the
     * command every time Tuple's state or log updates a switch: a share
     * starting would run `share` again, and stopping the webcam, then
     * refreshing before the log caught up, ran `webcam start`.
     */
    private _onToggle(item: PopupMenu.PopupSwitchMenuItem, handler: (state: boolean) => void) {
        item.connect('toggled', (_item, state) => {
            if (!this._settingSwitch)
                handler(state);
        });
    }

    /** Shows `state` on a switch without running its command. */
    private _setSwitch(item: PopupMenu.PopupSwitchMenuItem, state: boolean) {
        this._settingSwitch = true;
        try {
            item.setToggleState(state);
        } finally {
            this._settingSwitch = false;
        }
    }

    /**
     * A switch for sharing your screen or webcam. Clicking only starts the
     * command (which opens a picker); afterwards the switch goes back to what
     * Tuple's log reports, so a cancelled picker or a share stopped elsewhere
     * shows correctly. Without the log it remembers the click instead.
     */
    private _mediaSwitch(label: string, run: (on: boolean) => Promise<{ok: boolean}>,
        setGuess: (on: boolean) => void): PopupMenu.PopupSwitchMenuItem {
        const item = new PopupMenu.PopupSwitchMenuItem(label, false);
        this._onToggle(item, async state => {
            setGuess(state);
            const result = await run(state);
            if (!result.ok)
                setGuess(!state);
            this._sync();
        });
        return item;
    }

    /** Rebuilds the reaction rows (sounds, emoji, animations) when the CLI's list changes. */
    private _syncReactions(reactions: Reactions) {
        const key = JSON.stringify(reactions);
        if (key === this._reactionsKey)
            return;
        this._reactionsKey = key;
        const section = this._reactionsSection;
        section.removeAll();
        const react = (name: string) => this._actions.react(name);
        const row = (names: string[], emoji = false) => {
            if (names.length)
                section.addMenuItem(new ReactionRowItem(names.map(name => ({name, label: reactionLabel(name)})), react, {emoji}));
        };
        row(reactions.sounds);
        row(reactions.emoji, true);
        row(reactions.animations);
    }

    private _callSubtitle(call: Call | null): string {
        const parts = [];
        const started = this._callStart(call);
        if (started)
            parts.push(formatDuration((Date.now() - started) / 1000));
        if (call?.summary)
            parts.push(call.summary);
        return parts.join(' · ');
    }

    private _callStart(call: Call | null): number | null {
        return callStartedAt(call) ?? this._localCallStart;
    }

    private _syncContacts(inCall: boolean) {
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
                onRemove: c => this._actions.removeContact(c),
            }),
            update: (item, c) => item.update(c, {inCall}),
        });
    }

    private _syncLiveCalls(calls: OngoingCall[]) {
        this._liveCallsSub.label.text = `Live calls${calls.length ? ` · ${calls.length}` : ''}`;
        this._liveCallsEmpty.visible = calls.length === 0;
        syncItems(this._liveCallsList, this._liveCallItems, calls, {
            keyOf: c => c.id,
            create: () => new LiveCallItem({onActivate: c => this._actions.joinCall(c)}),
            update: (item, c) => item.update(c),
        });
    }

    private _inCallNow() {
        const s = this._store.status;
        return s === Status.IN_CALL || s === Status.OUTGOING;
    }

    private _syncRooms() {
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

    /**
     * For the keyboard shortcut: flips the mute switch as if it were clicked.
     * Returns the new state, or null when there's no call to mute in.
     */
    toggleMute() {
        if (this._store.status !== Status.IN_CALL)
            return null;
        this._muteSwitch.toggle();
        return this._muteSwitch.state;
    }

    private _syncPanel() {
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

    private _syncTimer(inCall: boolean) {
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

    private _tick() {
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

    private _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
}
