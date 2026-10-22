// Pure data helpers: no GI imports, so tests/model.test.js can run them under
// plain gjs. Everything that reads Tuple's JSON is defensive on purpose: the
// CLI is alpha, and some shapes (an active/ringing call, capture listings) can
// only be observed during a real call.

export const Status = Object.freeze({
    DOWN: 'down',               // daemon not running / CLI unreachable
    SIGNED_OUT: 'signed-out',
    OFFLINE: 'offline',         // daemon up, but no connection to Tuple's servers
    IDLE: 'idle',
    INCOMING: 'incoming',
    OUTGOING: 'outgoing',
    IN_CALL: 'in-call',
});

export const REACTIONS = Object.freeze(['airhorn', 'trombone', 'flute']);

const INCOMING_RE = /incoming|ring/;
const OUTGOING_RE = /outgoing|calling|dial|connecting/;

/**
 * Classifies `state.call` (from `tuple state`) as incoming, outgoing or active.
 * A call we are not in yet that is ringing is incoming; a call we are in that
 * is still ringing/connecting is one we placed.
 */
export function callPhase(state) {
    const call = state?.call;
    if (!call)
        return null;
    const s = String(call.state ?? '').toLowerCase();
    if (!state.in_call)
        return INCOMING_RE.test(s) || !s ? 'incoming' : 'other';
    if (OUTGOING_RE.test(s) || /ringing/.test(s))
        return 'outgoing';
    return 'active';
}

export function deriveStatus(state, daemonUp) {
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

export function personName(p) {
    if (p === null || p === undefined)
        return 'Someone';
    if (typeof p !== 'object')
        return String(p);
    const name = p.full_name || p.short_name || p.name || p.display_name || p.email;
    return String(name ?? p.id ?? p.user_id ?? 'Someone').trim();
}

export function shortName(p) {
    if (p && typeof p === 'object' && p.short_name)
        return p.short_name;
    return personName(p).split(/\s+/)[0];
}

/** Normalizes a call's participants (objects or bare ids) to a common shape. */
export function participantsOf(call, selfId) {
    const list = Array.isArray(call?.participants) ? call.participants : [];
    return list.map(p => {
        const obj = p && typeof p === 'object' ? p : {id: p};
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

export function otherParticipants(call, selfId) {
    return participantsOf(call, selfId).filter(p => !p.isSelf);
}

export function callTitle(call, selfId) {
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
export function callerName(call, selfId) {
    const others = otherParticipants(call, selfId);
    if (others.length)
        return joinNames(others.map(p => p.name));
    if (call?.caller)
        return personName(call.caller);
    return 'Someone';
}

export function joinNames(names) {
    if (names.length <= 1)
        return names[0] ?? '';
    if (names.length === 2)
        return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** true/false when known, null when the call payload doesn't say. */
export function selfMuted(call, selfId) {
    const me = participantsOf(call, selfId).find(p => p.isSelf);
    return me ? me.muted : null;
}

export function sharerId(call) {
    return call?.sharer_user_id ?? null;
}

export function isSelfSharing(call, selfId) {
    const id = sharerId(call);
    return id !== null && String(id) === String(selfId);
}

export function callStartedAt(call) {
    const t = Date.parse(call?.started_at ?? '');
    return Number.isNaN(t) ? null : t;
}

export function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// -- contacts ---------------------------------------------------------------

export function isOnline(contact) {
    return contact?.status === 'online' || contact?.status === 'available';
}

function statusRank(contact) {
    if (isOnline(contact))
        return 0;
    return contact?.status === 'busy' ? 1 : 2;
}

/** Favorites first, then online before busy before offline, then by name. */
export function sortContacts(contacts) {
    return [...(contacts ?? [])].sort((a, b) =>
        (b.favorited ? 1 : 0) - (a.favorited ? 1 : 0) ||
        statusRank(a) - statusRank(b) ||
        personName(a).localeCompare(personName(b)));
}

/** The argument `call start`/`participants add` accept for a contact. */
export function contactRef(contact) {
    return contact.email || personName(contact);
}

// -- rooms ------------------------------------------------------------------

export function roomLabel(room) {
    const name = room?.name?.trim();
    if (name)
        return name;
    return room?.kind === 'personal' ? 'My room' : room?.slug ?? 'Room';
}

export function personalRoom(rooms) {
    return (rooms ?? []).find(r => r.kind === 'personal') ?? null;
}

export function sortRooms(rooms) {
    const kindRank = r => (r.kind === 'personal' ? 0 : 1);
    return [...(rooms ?? [])].sort((a, b) =>
        (b.active_call ? 1 : 0) - (a.active_call ? 1 : 0) ||
        (b.favorited ? 1 : 0) - (a.favorited ? 1 : 0) ||
        kindRank(a) - kindRank(b) ||
        roomLabel(a).localeCompare(roomLabel(b)));
}

export function roomOccupants(room) {
    return Array.isArray(room?.members) ? room.members : [];
}

// -- history (tuple capture) -------------------------------------------------

function asList(data, ...keys) {
    if (Array.isArray(data))
        return data;
    for (const k of keys) {
        if (Array.isArray(data?.[k]))
            return data[k];
    }
    return [];
}

/** Normalizes `capture list` output. */
export function captureCalls(data) {
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

/** Normalizes `capture search` output. */
export function searchHits(data) {
    return asList(data, 'hits', 'matches', 'results').map(h => ({
        callId: String(h.call_id ?? h.call?.id ?? ''),
        text: String(h.snippet ?? h.text ?? h.content ?? '').replace(/\s+/g, ' ').trim(),
        speaker: h.speaker ? personName(h.speaker) : null,
        at: Date.parse(h.start ?? h.time ?? h.at ?? '') || null,
    })).filter(h => h.callId);
}

/** Normalizes `machines list` output. */
export function machinesOf(data) {
    return asList(data, 'machines').map(m => ({
        id: String(m.machine_id ?? m.id ?? ''),
        name: m.device_name || m.name || m.hostname || 'Machine',
    })).filter(m => m.id);
}

/** Parses the text table `tuple settings` prints: `name | value | description (a|b)`. */
export function parseSettings(text) {
    const out = [];
    for (const line of (text ?? '').split('\n')) {
        const m = line.match(/^\s*([\w-]+)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*$/);
        if (!m)
            continue;
        const [, name, value, description] = m;
        const choices = description.match(/\(([^()]*\|[^()]*)\)\s*$/);
        const options = choices ? choices[1].split('|').map(s => s.trim()) : null;
        let kind = 'text';
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

export function formatWhen(ms, now = Date.now()) {
    if (!ms)
        return '';
    const d = new Date(ms);
    const today = new Date(now);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const dayDiff = Math.round(
        (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
         new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (dayDiff === 0)
        return `Today ${time}`;
    if (dayDiff === 1)
        return `Yesterday ${time}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${time}`;
}

/** First http(s) URL in some text, e.g. the login link `tuple login` prints. */
export function firstUrl(text) {
    const m = (text ?? '').match(/https?:\/\/\S+/);
    return m ? m[0].replace(/[.,)]+$/, '') : null;
}
