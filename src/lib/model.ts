// Pure data helpers: no GI imports, so tests/model.test.js can run them under
// plain gjs. Everything that reads Tuple's JSON is defensive on purpose: the
// CLI is alpha, and some shapes (an active/ringing call, capture listings) can
// only be observed during a real call.

// -- Tuple's JSON ---------------------------------------------------------------
// Only the fields the extension reads, all optional: shapes vary between CLI
// releases. Payloads nobody has documented yet (call list, notifications) are
// read as `Json` and normalized below.

/** Parsed CLI output whose shape isn't pinned down. */
export type Json = any;
export type Id = string | number;

export interface Person {
    id?: Id;
    user_id?: Id;
    email?: string;
    full_name?: string;
    short_name?: string;
    name?: string;
    display_name?: string;
}

export interface Contact extends Person {
    kind?: string;              // teammate | external | agent
    status?: string;            // online | available | busy | offline
    favorited?: boolean;
}

export interface Room {
    slug: string;
    http_value: string;
    name?: string;
    kind?: string;              // personal | team
    favorited?: boolean;
    active_call?: boolean;
    members?: Person[];
}

export interface Participant extends Person {
    muted?: boolean;
}

export interface Call {
    id?: Id;
    state?: string;
    title?: string;
    summary?: string;
    started_at?: string;
    sharer_user_id?: Id | null;
    participants?: Array<Participant | Id>;
    room?: {name?: string} | null;
    caller?: Person;
    transcribing?: boolean;
    recorded?: boolean;
}

/** `tuple state` (the bounded summary). */
export interface TupleState {
    in_call?: boolean;
    call?: Call | null;
    user?: Person | null;
    connection?: {websocket_state?: string};
    contacts?: {online?: number};
    app_version?: string;
    available_update_version?: string | null;
}

export const Status = Object.freeze({
    DOWN: 'down',               // daemon not running / CLI unreachable
    SIGNED_OUT: 'signed-out',
    OFFLINE: 'offline',         // daemon up, but no connection to Tuple's servers
    IDLE: 'idle',
    INCOMING: 'incoming',
    OUTGOING: 'outgoing',
    IN_CALL: 'in-call',
} as const);
export type Status = typeof Status[keyof typeof Status];

export const REACTIONS = Object.freeze(['airhorn', 'trombone', 'flute'] as const);
export type Reaction = typeof REACTIONS[number];

export interface Shortcut {
    key: string;
    title: string;
    subtitle: string;
}

// Global keyboard shortcuts: gsettings key (type "as") -> labels for prefs.
export const SHORTCUTS: readonly Shortcut[] = Object.freeze([
    {key: 'shortcut-toggle-mute', title: 'Mute / unmute', subtitle: 'Toggle your microphone in the current call'},
    {key: 'shortcut-answer', title: 'Answer', subtitle: 'Pick up a ringing call'},
    {key: 'shortcut-leave', title: 'Leave call', subtitle: 'Hang up, or cancel a call you placed'},
    {key: 'shortcut-join-clipboard', title: 'Join link from clipboard', subtitle: 'Join the tuple.app link you copied'},
]);

const INCOMING_RE = /incoming|ring/;
const OUTGOING_RE = /outgoing|calling|dial|connecting/;

/**
 * Classifies `state.call` (from `tuple state`) as incoming, outgoing or active.
 * A call we are not in yet that is ringing is incoming; a call we are in that
 * is still ringing/connecting is one we placed.
 */
export function callPhase(state: TupleState | null): 'incoming' | 'outgoing' | 'active' | 'other' | null {
    const call = state?.call;
    if (!call)
        return null;
    const s = String(call.state ?? '').toLowerCase();
    if (!state?.in_call)
        return INCOMING_RE.test(s) || !s ? 'incoming' : 'other';
    if (OUTGOING_RE.test(s) || /ringing/.test(s))
        return 'outgoing';
    return 'active';
}

export function deriveStatus(state: TupleState | null, daemonUp: boolean): Status {
    if (!daemonUp || !state)
        return Status.DOWN;
    if (!state.user)
        return Status.SIGNED_OUT;
    const ws = state.connection?.websocket_state;
    if (ws && ws !== 'connected' && !state.in_call)
        return Status.OFFLINE;
    switch (callPhase(state)) {
    case 'incoming':
        return Status.INCOMING;
    case 'outgoing':
        return Status.OUTGOING;
    case 'active':
        return Status.IN_CALL;
    }
    return state.in_call ? Status.IN_CALL : Status.IDLE;
}

export function personName(p: Person | Id | null | undefined): string {
    if (p === null || p === undefined)
        return 'Someone';
    if (typeof p !== 'object')
        return String(p);
    const name = p.full_name || p.short_name || p.name || p.display_name || p.email;
    return String(name ?? p.id ?? p.user_id ?? 'Someone').trim();
}

export function shortName(p: Person | Id | null | undefined): string {
    if (p && typeof p === 'object' && p.short_name)
        return p.short_name;
    return personName(p).split(/\s+/)[0];
}

export interface CallMember {
    id: Id | null;
    key: string;
    name: string;
    shortName: string;
    email: string | null;
    muted: boolean | null;      // null: the payload doesn't say
    isSelf: boolean;
}

/** Normalizes a call's participants (objects or bare ids) to a common shape. */
export function participantsOf(call: Call | null | undefined, selfId: Id | null | undefined): CallMember[] {
    const list = Array.isArray(call?.participants) ? call.participants : [];
    return list.map(p => {
        const obj: Participant = p && typeof p === 'object' ? p : {id: p};
        const id = obj.id ?? obj.user_id ?? null;
        return {
            id,
            key: String(id ?? obj.email ?? personName(obj)),
            name: personName(obj),
            shortName: shortName(obj),
            email: obj.email ?? null,
            muted: typeof obj.muted === 'boolean' ? obj.muted : null,
            isSelf: selfId !== undefined && selfId !== null && String(id) === String(selfId),
        };
    });
}

export function otherParticipants(call: Call | null | undefined, selfId: Id | null | undefined): CallMember[] {
    return participantsOf(call, selfId).filter(p => !p.isSelf);
}

export function callTitle(call: Call | null | undefined, selfId: Id | null | undefined): string {
    if (!call)
        return '';
    if (call.title)
        return String(call.title);
    const others = otherParticipants(call, selfId).map(p => p.shortName);
    if (others.length)
        return `Call with ${joinNames(others)}`;
    const room = call.room?.name?.trim();
    return room ? room : 'Call';
}

/** Who is calling, for an incoming call. */
export function callerName(call: Call | null | undefined, selfId: Id | null | undefined): string {
    const others = otherParticipants(call, selfId);
    if (others.length)
        return joinNames(others.map(p => p.name));
    if (call?.caller)
        return personName(call.caller);
    return 'Someone';
}

export function joinNames(names: string[]): string {
    if (names.length <= 1)
        return names[0] ?? '';
    if (names.length === 2)
        return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** true/false when known, null when the call payload doesn't say. */
export function selfMuted(call: Call | null | undefined, selfId: Id | null | undefined): boolean | null {
    const me = participantsOf(call, selfId).find(p => p.isSelf);
    return me ? me.muted : null;
}

export function sharerId(call: Call | null | undefined): Id | null {
    return call?.sharer_user_id ?? null;
}

export function isSelfSharing(call: Call | null | undefined, selfId: Id | null | undefined): boolean {
    const id = sharerId(call);
    return id !== null && String(id) === String(selfId);
}

export function callStartedAt(call: Call | null | undefined): number | null {
    const t = Date.parse(call?.started_at ?? '');
    return Number.isNaN(t) ? null : t;
}

export function formatDuration(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// -- contacts ---------------------------------------------------------------

export function isOnline(contact: Contact | null | undefined): boolean {
    return contact?.status === 'online' || contact?.status === 'available';
}

function statusRank(contact: Contact): number {
    if (isOnline(contact))
        return 0;
    return contact?.status === 'busy' ? 1 : 2;
}

/** Favorites first, then online before busy before offline, then by name. */
export function sortContacts(contacts: Contact[] | null | undefined): Contact[] {
    return [...(contacts ?? [])].sort((a, b) =>
        (b.favorited ? 1 : 0) - (a.favorited ? 1 : 0) ||
        statusRank(a) - statusRank(b) ||
        personName(a).localeCompare(personName(b)));
}

/** The argument `call start`/`participants add` accept for a contact. */
export function contactRef(contact: Contact): string {
    return contact.email || personName(contact);
}

// -- rooms ------------------------------------------------------------------

export function roomLabel(room: Room | null | undefined): string {
    const name = room?.name?.trim();
    if (name)
        return name;
    return room?.kind === 'personal' ? 'My room' : room?.slug ?? 'Room';
}

export function personalRoom(rooms: Room[] | null | undefined): Room | null {
    return (rooms ?? []).find(r => r.kind === 'personal') ?? null;
}

export function sortRooms(rooms: Room[] | null | undefined): Room[] {
    const kindRank = (r: Room) => (r.kind === 'personal' ? 0 : 1);
    return [...(rooms ?? [])].sort((a, b) =>
        (b.active_call ? 1 : 0) - (a.active_call ? 1 : 0) ||
        (b.favorited ? 1 : 0) - (a.favorited ? 1 : 0) ||
        kindRank(a) - kindRank(b) ||
        roomLabel(a).localeCompare(roomLabel(b)));
}

export function roomOccupants(room: Room | null | undefined): Person[] {
    return Array.isArray(room?.members) ? room.members : [];
}

// -- history (tuple capture) -------------------------------------------------

function asList(data: Json, ...keys: string[]): Json[] {
    if (Array.isArray(data))
        return data;
    for (const k of keys) {
        if (Array.isArray(data?.[k]))
            return data[k];
    }
    return [];
}

export interface CaptureCall {
    id: string;
    title: string;
    people: string[];
    startedAt: number | null;
}

/** Normalizes `capture list` output. */
export function captureCalls(data: Json): CaptureCall[] {
    return asList(data, 'calls', 'captures', 'items').map(c => {
        const people = Array.isArray(c.participants) ? c.participants.map(personName) : [];
        return {
            id: String(c.call_id ?? c.id ?? ''),
            title: c.title || c.summary || (people.length ? joinNames(people) : 'Untitled call'),
            people,
            startedAt: Date.parse(c.started_at ?? c.start ?? '') || null,
        };
    }).filter(c => c.id);
}

export interface SearchHit {
    callId: string;
    text: string;
    speaker: string | null;
    at: number | null;
}

/** Normalizes `capture search` output. */
export function searchHits(data: Json): SearchHit[] {
    return asList(data, 'hits', 'matches', 'results').map(h => ({
        callId: String(h.call_id ?? h.call?.id ?? ''),
        text: String(h.snippet ?? h.text ?? h.content ?? '').replace(/\s+/g, ' ').trim(),
        speaker: h.speaker ? personName(h.speaker) : null,
        at: Date.parse(h.start ?? h.time ?? h.at ?? '') || null,
    })).filter(h => h.callId);
}

// -- ongoing calls (tuple call list) ------------------------------------------

/**
 * Normalizes `call list` output. Its shape isn't documented and only shows up
 * while teammates are on calls, so this accepts the field names `state.call`
 * and rooms use. `target` is what `call join` takes: the call's URL, or else
 * someone on it (join by person).
 */
export interface OngoingCall {
    id: string;
    title: string;
    people: Array<{name: string, shortName: string, email: string | null}>;
    url: string | null;
    target: string;
    favorited: boolean;
    startedAt: number | null;
}

export function ongoingCalls(data: Json): OngoingCall[] {
    return asList(data, 'calls', 'items').map(c => {
        const people = asList(c.participants ?? c.members, 'participants').map(p => ({
            name: personName(p),
            shortName: shortName(p),
            email: p?.email ?? null,
        }));
        const room = c.room && typeof c.room === 'object' ? c.room : null;
        const url = c.http_value || c.url || c.join_url || room?.http_value || null;
        return {
            id: String(c.id ?? c.call_id ?? url ?? ''),
            title: String(c.title || room?.name || '').trim(),
            people,
            url,
            target: url || people[0]?.email || (people.length ? people[0].name : null),
            favorited: !!c.favorited,
            startedAt: Date.parse(c.started_at ?? '') || null,
        };
    }).filter((c): c is OngoingCall => !!(c.id && c.target));
}

export function ongoingCallLabel(call: OngoingCall): string {
    if (call.title)
        return call.title;
    return call.people.length ? `Call with ${joinNames(call.people.map(p => p.shortName))}` : 'Call';
}

// -- call notification cards (tuple notifications) ----------------------------

// A card is done once it is answered or withdrawn; anything else still shows.
export interface Card {
    id: string;
    title: string;
    body: string;
    sender: string;
    ask: boolean;               // a question (accept/reject), not just a notice
    open: boolean;              // still showing in the call
}

const CARD_CLOSED_RE = /accept|reject|declin|cancel|dismiss|expire|resolv|clos|withdr|timeout|timed.?out|\banswered|\bdone/;

/**
 * Normalizes `notifications list` / `notifications follow` output: notification
 * cards an agent or integration posted into the current call. Undocumented, so
 * this takes either a snapshot (a list, or {notifications: [...]}) or a single
 * lifecycle event ({event, notification} or a bare card). `snapshot` says
 * whether cards missing from `cards` are gone.
 */
export function notificationCards(data: Json): {snapshot: boolean, cards: Card[]} {
    const snapshot = Array.isArray(data) || Array.isArray(data?.notifications) || Array.isArray(data?.items);
    const raw = snapshot ? asList(data, 'notifications', 'items') : [data];
    const cards = raw.map(item => {
        const card: Json = [item?.notification, item?.data, item].find(x => x && typeof x === 'object') ?? {};
        const lifecycle = String(card.state ?? card.status ?? item?.event ?? item?.state ?? '').toLowerCase();
        const kind = String(card.kind ?? card.type ?? '').toLowerCase();
        const sender = card.sender;
        return {
            id: String(card.id ?? card.notification_id ?? item?.id ?? ''),
            title: String(card.title ?? '').trim(),
            body: String(card.body ?? card.message ?? '').trim(),
            sender: sender && typeof sender === 'object' ? personName(sender) : String(sender ?? '').trim(),
            ask: /ask|decision|question/.test(kind) || 'accept_label' in card,
            open: !CARD_CLOSED_RE.test(lifecycle) && !card.response,
        };
    }).filter(c => c.id);
    return {snapshot, cards};
}

export interface Machine {
    id: string;
    name: string;
}

/** Normalizes `machines list` output. */
export function machinesOf(data: Json): Machine[] {
    return asList(data, 'machines').map(m => ({
        id: String(m.machine_id ?? m.id ?? ''),
        name: m.device_name || m.name || m.hostname || 'Machine',
    })).filter(m => m.id);
}

export interface TupleSetting {
    name: string;
    value: string;
    description: string;
    kind: 'text' | 'bool' | 'choice';
    options: string[] | null;
}

/** Parses the text table `tuple settings` prints: `name | value | description (a|b)`. */
export function parseSettings(text: string | null | undefined): TupleSetting[] {
    const out: TupleSetting[] = [];
    for (const line of (text ?? '').split('\n')) {
        const m = line.match(/^\s*([\w-]+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*$/);
        if (!m)
            continue;
        const [, name, value, description] = m;
        const choices = description.match(/\(([^()]*\|[^()]*)\)\s*$/);
        const options = choices ? choices[1].split('|').map(s => s.trim()) : null;
        let kind: TupleSetting['kind'] = 'text';
        if (options && options.length === 2 && options.includes('0') && options.includes('1'))
            kind = 'bool';
        else if (options)
            kind = 'choice';
        out.push({
            name,
            value,
            description: description.replace(/\s*\([^()]*\)\s*$/, ''),
            kind,
            options,
        });
    }
    return out;
}

export function formatWhen(ms: number | null, now = Date.now()): string {
    if (!ms)
        return '';
    const d = new Date(ms);
    const today = new Date(now);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const dayDiff = Math.round(
        (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
         new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    if (dayDiff === 0)
        return `Today ${time}`;
    if (dayDiff === 1)
        return `Yesterday ${time}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${time}`;
}

/** First http(s) URL in some text, e.g. the login link `tuple login` prints. */
export function firstUrl(text: string | null | undefined): string | null {
    const m = (text ?? '').match(/https?:\/\/\S+/);
    return m ? m[0].replace(/[.,)]+$/, '') : null;
}
