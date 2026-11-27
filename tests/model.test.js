// Run: npm test (builds, then runs this against the compiled build/lib)
import System from 'system';

import {
    Status, callPhase, callTitle, callerName, captureCalls, deriveStatus, firstUrl,
    DEFAULT_REACTIONS, applyMediaLog, connectArgs, formatDuration, holdOnFailure, terminalArgv, joinNames, notificationCards, ongoingCallLabel, ongoingCalls,
    parseHelpCommands, parseReactions, parseSettings, participantsOf, reactionLabel, roomLabel, searchHits,
    selfMuted, sortContacts,
} from '../build/lib/model.js';
import {cleanError} from '../build/lib/cli.js';

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
    'webcam |  | Webcam device last picked',
].join('\n');
eq(parseSettings(settingsText).map(s => [s.name, s.value, s.kind, s.options]), [
    ['overlay', '1', 'bool', ['0', '1']],
    ['capture', 'auto', 'choice', ['auto', 'x11', 'portal']],
    ['guest-mode', 'annotation', 'choice', ['annotation', 'control']],
    ['transcription-model', '', 'text', null],
    ['webcam', '', 'text', null],
], 'settings parsed');

// -- help text (real v2026_11_19.0 output) ----------------------------------------------
const reactHelp = [
    'Send a reaction to everyone on the call.',
    '',
    'Sounds play for everyone, yourself included: airhorn, trombone, flute.',
    'Emoji show on your webcam tile: thumbs-up, plus-one, thumbs-down, clap, laugh, heart, tada, wow.',
    'Animations play on your webcam tile: ship-it, table-flip, this-is-fine.',
    '',
    'Usage:',
    '  tuple call react <reaction> [flags]',
    '',
    'Flags:',
    '      --call string   call ID (default "current")',
    '  -h, --help          help for react',
    '',
    'Global Flags:',
    '      --format format   output format: "text" or "json" (default text)',
].join('\n');
eq(parseReactions(reactHelp), {
    sounds: ['airhorn', 'trombone', 'flute'],
    emoji: ['thumbs-up', 'plus-one', 'thumbs-down', 'clap', 'laugh', 'heart', 'tada', 'wow'],
    animations: ['ship-it', 'table-flip', 'this-is-fine'],
}, 'reactions from call react --help');
eq(parseReactions('Send a reaction.\n\nUsage:\n  tuple call react <reaction> [flags]\n'), DEFAULT_REACTIONS,
    'reactions: older help without lists -> sounds only');
eq(parseReactions(''), DEFAULT_REACTIONS, 'reactions: no help');
eq([reactionLabel('trombone'), reactionLabel('tada'), reactionLabel('table-flip'), reactionLabel('mind_blown')],
    ['Sad trombone', '🎉', 'Table flip', 'Mind blown'], 'reaction labels');

const callHelp = [
    'Call lifecycle',
    '',
    'Usage:',
    '  tuple call [flags]',
    '  tuple call [command]',
    '',
    'Available Commands:',
    '  accept       Accept an incoming call',
    '  lower-hand   Lower your raised hand',
    '  raise-hand   Raise your hand on your webcam tile',
    '  react        Send a reaction',
    '',
    'Flags:',
    '  -h, --help   help for call',
].join('\n');
eq(parseHelpCommands(callHelp, 'call '), ['call accept', 'call lower-hand', 'call raise-hand', 'call react'],
    'call subcommands');
eq(parseHelpCommands('Available Commands:\n  help   Help\n  webcam  Cams\n\nDeprecated Commands:\n  share  Share\n'),
    ['webcam', 'share'], 'top-level commands, deprecated included, help left out');

// -- sharing state from Tuple's daemon log (real v2026_11_19.0 lines) ---------------------
const off = {screen: false, webcam: false};
const webcamOn = [
    '05:34:08.453|4489|4489|info(webcam)|capturing camera serial 77',
    '05:34:10.946|4489|4489|info|share webcam serial 77 id 1',
    '05:34:10.946|4489|4500|info|Call.cpp:2407|OnWebcamCapturerStateChange: starting',
    '05:34:10.961|4489|4500|info|Call.cpp:2407|OnWebcamCapturerStateChange: running',
].join('\n');
eq(applyMediaLog(off, webcamOn), {state: {screen: false, webcam: true}, matched: true}, 'log: webcam shared');
eq(applyMediaLog(off, '05:34:08.453|4489|4489|info(webcam)|capturing camera serial 77\n'),
    {state: off, matched: false}, 'log: picker preview alone is not sharing');
eq(applyMediaLog({screen: false, webcam: true},
    '05:34:14.712|4489|4500|info|Call.cpp:2407|OnWebcamCapturerStateChange: stopped\n').state,
    off, 'log: webcam stopped');
eq(applyMediaLog(off, [
    '05:40:09.056|4489|4489|info|Call.cpp:2100|OnVideoCapturerDesktop Start',
    '05:40:15.835|4489|4489|info|portal closed screencast session \'/org/freedesktop/portal/desktop/session/1_142/Session\'',
    '05:40:15.835|4489|4489|info|Call.cpp:2150|OnVideoCapturerDesktop Stop lost=false',
].join('\n')).state, off, 'log: screen started then stopped from GNOME, last line wins');
eq(applyMediaLog(off, '05:40:09.056|4489|4489|info|Call.cpp:2100|OnVideoCapturerDesktop Start\n').state,
    {screen: true, webcam: false}, 'log: screen shared');
eq(applyMediaLog({screen: true, webcam: true}, 'launching from pid 4382...\n'),
    {state: off, matched: true}, 'log: a new daemon resets sharing');

// -- AI agent: tuple connect in a terminal ---------------------------------------------
eq(connectArgs(null, ''), ['connect'], 'connect: current call, no purpose');
eq(connectArgs('a1b2', 'why did the build fail?'), ['connect', '--call', 'a1b2', '--', 'why did the build fail?'],
    'connect: stored call, purpose after --');
eq(connectArgs(null, '-v'), ['connect', '--', '-v'], 'connect: purpose starting with - is not a flag');
const installed = (...names) => name => names.includes(name);
eq(terminalArgv(['tuple', 'connect'], {has: installed('ptyxis', 'kitty')}),
    ['ptyxis', '--new-window', '--', 'tuple', 'connect'], 'terminal: first known one installed');
eq(terminalArgv(['tuple', 'connect'], {preferred: 'kitty', has: installed('ptyxis', 'kitty')}),
    ['kitty', 'tuple', 'connect'], "terminal: GNOME's default when installed");
eq(terminalArgv(['tuple', 'connect'], {preferred: 'xdg-terminal-exec', has: installed('ptyxis')}),
    ['ptyxis', '--new-window', '--', 'tuple', 'connect'], 'terminal: default not installed -> fallback');
eq(terminalArgv(['tuple'], {custom: ['alacritty', '-e'], has: installed('alacritty')}),
    ['alacritty', '-e', 'tuple'], 'terminal: custom prefix');
eq(terminalArgv(['tuple'], {custom: ['nope'], has: installed('ptyxis')}), null, 'terminal: custom missing');
eq(terminalArgv(['tuple'], {has: installed()}), null, 'terminal: none installed');
eq(holdOnFailure(['tuple', 'connect']).slice(0, 2).concat(holdOnFailure(['tuple', 'connect']).slice(3)),
    ['sh', '-c', 'sh', 'tuple', 'connect'], 'hold on failure: command passed as arguments, not in the script');

// -- history ---------------------------------------------------------------------
eq(captureCalls([{call_id: 'abc', participants: [ada], started_at: '2026-10-20T10:00:00Z'}]).map(c => [c.id, c.title]),
    [['abc', 'Ada Lovelace']], 'capture list array');
eq(captureCalls([{call_id: 'abc', participants: [ada]}, {call_id: 'def', title: 'Pairing'}]).map(c => c.realTitle),
    ['', 'Pairing'], 'capture list: real title, not the fallback, for renaming');
eq(captureCalls({calls: [{id: 'x', title: 'Pairing'}]}).map(c => c.title), ['Pairing'], 'capture list wrapped');
eq(searchHits({hits: [{call_id: 'abc', snippet: ' hello\n world ', speaker: ada}]}).map(h => [h.text, h.speaker]),
    [['hello world', 'Ada Lovelace']], 'search hits');

// -- ongoing calls (call list) ---------------------------------------------------------
const grace = {id: 3, full_name: 'Grace Hopper', short_name: 'Grace', email: 'grace@example.com'};
const live = ongoingCalls([
    {id: 'c1', room: {name: 'Weekly sync ', http_value: 'https://tuple.app/c/w33kly'}, participants: [ada, grace]},
    {id: 'c2', participants: [grace]},
    {id: 'c3', participants: []},
]);
eq(live.map(c => [c.id, c.target, ongoingCallLabel(c)]), [
    ['c1', 'https://tuple.app/c/w33kly', 'Weekly sync'],
    ['c2', 'grace@example.com', 'Call with Grace'],
], 'ongoing calls: room url, else join by person; nothing to join -> dropped');
eq(ongoingCalls({calls: [{call_id: 'x', http_value: 'https://tuple.app/c/x'}]}).map(c => c.id), ['x'],
    'ongoing calls wrapped');
eq(ongoingCalls(null), [], 'ongoing calls: nothing');

// -- notification cards ------------------------------------------------------------------
const snap = notificationCards([
    {id: 'n1', kind: 'notice', state: 'shown', title: 'Hi', body: 'There', sender: 'Claude'},
    {id: 'n2', kind: 'ask', state: 'pending', title: 'Push?', sender: {full_name: 'Bot'}},
    {id: 'n3', kind: 'ask', state: 'accepted', title: 'Old'},
]);
eq(snap.snapshot, true, 'cards: list is a snapshot');
eq(snap.cards.map(c => [c.id, c.ask, c.open, c.sender]),
    [['n1', false, true, 'Claude'], ['n2', true, true, 'Bot'], ['n3', true, false, '']], 'cards: kind, state, sender');
const event = notificationCards({event: 'canceled', notification: {id: 'n2', title: 'Push?'}});
eq([event.snapshot, event.cards.map(c => [c.id, c.open])], [false, [['n2', false]]], 'cards: lifecycle event');
eq(notificationCards({id: 'n4', title: 'x', response: {accepted: true}}).cards[0].open, false,
    'cards: a response closes it');
eq(notificationCards({notifications: [{id: 'n5', accept_label: 'Yes'}]}).cards.map(c => [c.ask, c.open]),
    [[true, true]], 'cards: wrapped snapshot, accept_label means ask');
eq(notificationCards({error: 'not in a call'}).cards, [], 'cards: error is no card');

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
