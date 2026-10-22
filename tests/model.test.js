// Run: gjs -m tests/model.test.js
import System from 'system';

import {
    Status, callPhase, callTitle, callerName, captureCalls, deriveStatus, firstUrl,
    formatDuration, joinNames, parseSettings, participantsOf, roomLabel, searchHits,
    selfMuted, sortContacts,
} from '../src/lib/model.js';
import {cleanError} from '../src/lib/cli.js';

let failures = 0;
let passes = 0;

function eq(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passes++;
    } else {
        failures++;
        printerr(`FAIL ${what}\n  expected ${e}\n  actual   ${a}`);
    }
}

const ME = 1000;
const user = {id: ME, email: 'me@example.com', short_name: 'Alex'};
const idle = {in_call: false, call: null, user, connection: {websocket_state: 'connected'}};
const ada = {id: 1, full_name: 'Ada Lovelace', short_name: 'Ada', email: 'ada@example.com'};

// -- status ----------------------------------------------------------------
eq(deriveStatus(null, false), Status.DOWN, 'no state -> down');
eq(deriveStatus(idle, false), Status.DOWN, 'stream down -> down');
eq(deriveStatus({...idle, user: null}, true), Status.SIGNED_OUT, 'no user -> signed out');
eq(deriveStatus({...idle, connection: {websocket_state: 'connecting'}}, true), Status.OFFLINE, 'websocket down -> offline');
eq(deriveStatus(idle, true), Status.IDLE, 'idle');
eq(deriveStatus({...idle, in_call: true, call: {id: 'c1', state: 'active', participants: [user, ada]}}, true),
    Status.IN_CALL, 'active call');
eq(deriveStatus({...idle, in_call: false, call: {id: 'c1', state: 'incoming', participants: [ada]}}, true),
    Status.INCOMING, 'incoming call');
eq(deriveStatus({...idle, in_call: false, call: {id: 'c1', state: 'ringing'}}, true),
    Status.INCOMING, 'ringing, not in call -> incoming');
eq(deriveStatus({...idle, in_call: true, call: {id: 'c1', state: 'ringing'}}, true),
    Status.OUTGOING, 'ringing while in call -> outgoing');
eq(deriveStatus({...idle, in_call: true, call: {id: 'c1', state: 'connecting_outgoing'}}, true),
    Status.OUTGOING, 'connecting_outgoing -> outgoing');
eq(deriveStatus({...idle, in_call: true, call: null}, true), Status.IN_CALL, 'in_call without call payload');
eq(deriveStatus({...idle, in_call: true, call: {id: 'c', state: 'active'}, connection: {websocket_state: 'reconnecting'}}, true),
    Status.IN_CALL, 'a call survives a websocket blip');
eq(callPhase({in_call: false, call: {state: 'ended'}}), 'other', 'ended call not in it -> other');

// -- calls -------------------------------------------------------------------
const call = {id: 'c1', state: 'active', participants: [{...user, muted: true}, ada, {id: 3, short_name: 'Grace'}]};
eq(participantsOf(call, ME).map(p => [p.name, p.isSelf, p.muted]),
    [['Alex', true, true], ['Ada Lovelace', false, null], ['Grace', false, null]], 'participants normalized');
eq(participantsOf({participants: [5, 6]}, 5).map(p => p.isSelf), [true, false], 'bare id participants');
eq(selfMuted(call, ME), true, 'self muted from payload');
eq(selfMuted({participants: [ada]}, ME), null, 'self muted unknown');
eq(callTitle(call, ME), 'Call with Ada and Grace', 'call title from others');
eq(callTitle({...call, title: 'Standup'}, ME), 'Standup', 'explicit call title');
eq(callerName({participants: [ada]}, ME), 'Ada Lovelace', 'caller name');
eq(joinNames(['A', 'B', 'C']), 'A, B and C', 'joinNames 3');
eq(formatDuration(65), '1:05', 'duration m:ss');
eq(formatDuration(3725), '1:02:05', 'duration h:mm:ss');

// -- contacts / rooms -----------------------------------------------------------
const contacts = [
    {id: 1, full_name: 'Zed', status: 'online', favorited: false},
    {id: 2, full_name: 'Amy', status: 'offline', favorited: true},
    {id: 3, full_name: 'Bob', status: 'online', favorited: true},
    {id: 4, full_name: 'Cat', status: 'busy', favorited: false},
];
eq(sortContacts(contacts).map(c => c.full_name), ['Bob', 'Amy', 'Zed', 'Cat'], 'contact sort');
eq(roomLabel({name: '  ', kind: 'personal', slug: 'x'}), 'My room', 'personal room label');
eq(roomLabel({name: 'Weekly sync ', kind: 'team'}), 'Weekly sync', 'team room label trimmed');

// -- settings table (real `tuple settings` output) ----------------------------------
const settingsText = [
    'overlay | 1 | Show "overlay" annotation window when sharing screen (0|1)',
    'capture | auto | Screen capture mechanism (auto|x11|portal)',
    'guest-mode | annotation | Current mode in screen window (annotation|control)',
    'transcription-model |  | File path to whisper ggml model',
].join('\n');
eq(parseSettings(settingsText).map(s => [s.name, s.value, s.kind, s.options]), [
    ['overlay', '1', 'bool', ['0', '1']],
    ['capture', 'auto', 'choice', ['auto', 'x11', 'portal']],
    ['guest-mode', 'annotation', 'choice', ['annotation', 'control']],
    ['transcription-model', '', 'text', null],
], 'settings parsed');

// -- history ---------------------------------------------------------------------
eq(captureCalls([{call_id: 'abc', participants: [ada], started_at: '2026-10-20T10:00:00Z'}]).map(c => [c.id, c.title]),
    [['abc', 'Ada Lovelace']], 'capture list array');
eq(captureCalls({calls: [{id: 'x', title: 'Pairing'}]}).map(c => c.title), ['Pairing'], 'capture list wrapped');
eq(searchHits({hits: [{call_id: 'abc', snippet: ' hello\n world ', speaker: ada}]}).map(h => [h.text, h.speaker]),
    [['hello world', 'Ada Lovelace']], 'search hits');

// -- errors & urls --------------------------------------------------------------------
eq(cleanError('{"error":"not in a call"}'), 'not in a call', 'json error');
eq(cleanError('00:08:49.264|25104|25104|error|start does not take any command-line args'),
    'start does not take any command-line args', 'daemon log error');
eq(cleanError('00:08:58.594|1|1|warning|deprecated\n00:08:58.594|1|1|error|boom'), 'boom', 'prefers error line');
eq(cleanError('error: too many cmdline args for \'login\''), "too many cmdline args for 'login'", 'cobra error');
eq(firstUrl('Open https://tuple.app/login?x=1. Then paste'), 'https://tuple.app/login?x=1', 'first url');

print(`${passes} passed, ${failures} failed`);
if (failures)
    System.exit(1);
