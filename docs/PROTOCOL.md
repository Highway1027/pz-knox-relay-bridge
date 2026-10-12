<!-- docs/PROTOCOL.md -->
<!-- v6 - 27-09-2026 - Telemetry snapshot and open knox_ missions (envelope) -->

# Protocol version 1

PZ writes `game-to-bridge/pending/<messageId>.json` containing `connector_test` and `hello from Project Zomboid`.

The Bridge posts:

```json
{
  "protocolVersion": 1,
  "connectorVersion": "0.2.8",
  "message": "hello from Project Zomboid"
}
```

It accepts only:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "message": "hello from Knox Relay"
}
```

It then writes `bridge-to-game/pending/ack_<messageId>.json`:

```json
{
  "protocolVersion": 1,
  "messageId": "ack_evt_...",
  "replyTo": "evt_...",
  "type": "connector_test_ack",
  "createdAt": "2026-09-23T12:00:01.000Z",
  "payload": { "ok": true, "message": "hello from Knox Relay" }
}
```

## Latest game telemetry

PZ overwrites `game-to-bridge/telemetry/current.json` about every ten seconds while at least one player is connected. The local message contains `protocolVersion`, `messageId`, `type: game_telemetry`, `createdAt`, and a payload with structured game time plus 1–32 player identity/coordinate records.

Connector 0.13.0+ adds an optional `payload.snapshot` about once a minute: a world/player summary for the mission engine (`schemaVersion`, `world`, `players`, `capabilities`). The Bridge checks it as a bounded envelope only (plain JSON, at most 64 KB, depth 8, strings up to 1,000 characters, lists up to 256 entries, simple keys; `src/protocol/KnoxEnvelope.ts`) and forwards it unchanged. The backend validates the content.

The Bridge validates exact fields, adds configured `networkId` and `connectorVersion`, and POSTs with `Content-Type: application/json` and `X-Knox-Connector-Token`. The backend response must be `{ "ok": true, "protocolVersion": 1, "messageId": "evt_..." }` for the same message ID.

Unknown fields, versions/types, malformed dates, empty player arrays, invalid names, and non-finite/out-of-range coordinates fail closed.

## Mission delivery

The Bridge posts authenticated `pull` requests to `knoxMissionSync`. The backend answers with one pending mission or `null`. After validation, the Bridge atomically writes `bridge-to-game/pending/mission_<missionId>.json` and tells the backend it is locally queued. Existing pending or processed files suppress recreation. PZ writes a strict `mission_received_ack` into `game-to-bridge/pending`; the Bridge then archives both files.

Accepted mission ids:

- `mission_v0_*` (curated) and `mission_v02_recon_*` (dynamic recon): `visit_area` missions with exact-key checks (`validateMission` in `src/protocol/KnoxValidators.ts`). Always `missionVersion` 1.
- `knox_*` (open missions): envelope checks only, see below.

The Phase 4–6B test missions `test_001`–`test_007` were retired in Bridge 0.2.5 and are rejected like any unknown id.

`missionId` identifies the logical mission and `missionVersion` identifies its payload revision, so a newer revision can be told apart from a duplicate.

## Open missions (`knox_` ids, Bridge 0.2.4+)

Missions whose id matches `knox_[a-z0-9_]{1,96}` come from the mission engine and use the open mission format. The Bridge checks the envelope only: `protocolVersion` 1, the id, an integer `missionVersion` (1–100,000), a `title` of 1–120 characters, and plain bounded JSON (at most 32 KB, depth 10). The Connector validates and interprets the content. Their `mission_completed` and `mission_declined` events may carry any `missionVersion` from 1 and an `objectiveType` of lowercase letters and underscores. All older mission ids keep their exact checks.

**Index (Bridge 0.2.5+).** PZ Lua cannot list a folder, so the Bridge keeps `bridge-to-game/pending/knox_missions.json` up to date: `{ "protocolVersion": 1, "missionIds": ["knox_...", ...] }`, sorted, at most 64 ids, one per `mission_knox_*.json` file waiting in that folder. It is rewritten atomically after each poll when the list changed or the file is missing. The Connector (builds after 0.14.1) reads the index, then each listed mission file.

## Save identity (Bridge 0.2.6+)

Connector MISSION_API 13.9: each save links itself to one Knox network and ignores missions from other networks or for other saves.

- **Mission files name their network.** The Bridge adds `networkId` and, when the connection has a name, `connectionName` (trimmed, at most 80 characters) to every mission file it writes, after validating the backend's mission. A `saveId` the backend put on a `knox_` mission passes through unchanged.
- **Outcomes name their save.** `mission_completed` and `mission_declined` accept an optional `payload.saveId` (`save_` plus 1–40 lowercase letters or digits; anything else fails validation). The Bridge forwards it to `knoxMissionSync` as `saveId` on the `completed` / `declined` request; without it the request is unchanged.
- The snapshot's `saveId` needs nothing from the Bridge: the snapshot is checked as an envelope only.

## Mission state events (Bridge 0.2.6+)

Besides completion and decline, the Connector reports the other state changes of a Knox mission, once per mission version: `mission_accepted` (`payload.acceptedBy`), `mission_abandoned` (`payload.abandonedBy`), `mission_failed` (`payload.reason`, a short sentence) and, from Bridge 0.2.7 (Connector 0.18.1), `mission_expired` (`payload.reason`; the mission was closed by its deadline). Same envelope and checks as `mission_declined`: `missionId`, `missionVersion`, the one field (a string of 1–200 characters) and optionally `saveId`; nothing else. The Bridge forwards each to `knoxMissionSync` with `action` `accepted` / `abandoned` / `failed` / `expired`, plus `saveId` when present and, for `failed` and `expired`, `reason`. A backend error keeps the file queued and retries with backoff, like an outcome. Files are handled in name order, so an `abandoned` may reach the backend before its `accepted`; the backend never lets `accepted` replace a closed state.

## Mission requests (Bridge 0.2.9+, Connector 0.21.0)

The in-game "New mission" button. The Connector server writes `game-to-bridge/pending/mission_request_<requestId>.json`: the usual envelope with `type` `mission_request` and `payload` `{ requestId, requestedBy, saveId? }` (requestId `req_[a-z0-9_]{1,64}`, requestedBy the username, 1–64 characters; nothing else). The Bridge posts it to `knoxMissionSync` with `action` `request`, `requestId`, `requestedBy` and `saveId` when present. The backend answers at once: `{ ok, protocolVersion, requestId, status: "accepted" | "refused", reason?, message? }` (reasons `busy`, one request open per network, and `daily_limit`, 10 per 24 hours unless the network owner is a developer). The Bridge writes that answer atomically to `bridge-to-game/pending/knox_request_status.json` as `{ protocolVersion, requestId, status, reason?, message?, recent }` (the latest request at the top; `recent`, Bridge 0.2.13+: the last 8 answers of this kind, newest last, so two presses close together each find their own) and archives the event. A backend error keeps the file queued and retries with backoff. The mission itself is generated afterwards (a backend trigger, minutes) and arrives on the normal mission pull. Bridges before 0.2.9 move a `mission_request` file to `failed`.

## Radio messages (Bridge 0.2.10+, Connector 0.23.0)

Messages outside missions, from people in the story. First kind: `arc_end`, the contact's closing line when a story arc ends. Every mission poll the Bridge also posts `knoxMissionSync` with `action` `messages` (no other fields). The backend answers `{ ok, protocolVersion, message }`, where `message` is `null` or exactly `{ protocolVersion: 1, messageId, kind, saveId, sender, senderRole, title, text }`: messageId `msg_[a-z0-9_]{1,96}`, kind `[a-z_]{1,32}` (not checked further: new kinds need no Bridge release), saveId a save id or `null`, sender 1–64 characters, senderRole up to 40 or `null`, title up to 60 or `null`, text 1–400. The Bridge writes it atomically to `bridge-to-game/pending/message_<messageId>.json` with `networkId` added (only when neither that file nor its `processed` copy exists), posts `action` `message_queued` with `messageId`, and rewrites `bridge-to-game/pending/knox_messages.json` as `{ protocolVersion, messageIds }` (sorted, up to 64) whenever the list changes. The Connector stores each id once, then writes `game-to-bridge/pending/` a `message_received_ack` envelope with `payload` `{ messageId }`; the Bridge moves the message file to `processed`. Bridges before 0.2.10 never ask for messages; the backend keeps them pending.

## World history for the Journal window (Bridge 0.2.11+, Connector 0.32.0)

The Bridge learns the save being played from `payload.snapshot.saveId` in the telemetry (`save_[a-z0-9]{1,40}`, about once a minute). For that save it posts `knoxMissionSync` with `action` `history` and `saveId`: at once when the save is new, then every 5 minutes (backoff after an error). The backend answers exactly `{ ok, protocolVersion, saveId, journalEnabled, journal, recaps }`; `saveId` must be the one asked for. `journal` (up to 200; the backend sends the 10 newest per character, newest first): `{ id, dayKey, username, characterName, title, text }` with id `[A-Za-z0-9_-]{1,128}`, dayKey `YYYY-MM-DD`, names 1–64, title 0–80, text 1–1600. `recaps` (up to 10; the backend sends 3, newest first): `{ id, startDay, endDay, endedAtMs, title, text }` with days `YYYY-MM-DD` or empty, text 1–1200. The Bridge writes `bridge-to-game/pending/knox_history.json` atomically as `{ protocolVersion, saveId, journalEnabled, journal, recaps }`, only when it changed or the file is missing. One file, replaced as a whole; the game never acknowledges it. Bridges before 0.2.11 never write it.

## Journal requests (Bridge 0.2.12+, Mission Board 0.36.0)

The in-game "Write journal entry now" button. The Connector server writes `game-to-bridge/pending/journal_request_<requestId>.json`: the usual envelope with `type` `journal_request` and `payload` exactly `{ requestId, requestedBy, saveId }` (requestId `jrq_[a-z0-9_]{1,64}`, requestedBy the username, 1–64 characters, saveId required). The Bridge posts it to `knoxMissionSync` with `action` `journal_now` and the same three fields. The backend answers at once like a mission request: `{ ok, protocolVersion, requestId, status: "accepted" | "refused", reason?, message? }` (reasons `journal_off`, `nothing_yet`, `nothing_new`, `no_room`, `busy`, `daily_limit`; `message` is the sentence to show). The Bridge writes it atomically to `bridge-to-game/pending/knox_journal_status.json` as `{ protocolVersion, requestId, status, reason?, message?, recent }` (the latest press at the top; `recent`, Bridge 0.2.13+: the last 8 answers, newest last; Mission Board 0.36.2 finds its own press there) and archives the event; a backend error keeps the file queued and retries with backoff. The entry itself is written by a backend trigger (seconds) into the normal history feed; after an accepted press the Bridge fetches the history every 20 seconds, 5 times, then returns to every 5 minutes. Bridges before 0.2.12 move a `journal_request` file to `failed`.

## Bridge detection: heartbeats both ways (Bridge 0.3.0, Mission Board 0.37.0)

Agreed with Tim 11-10-2026 (Connector plan, "Bridge heartbeat file and Bridge detection"). Before 0.3.0 the game guessed the Bridge was off when a request file still waited after 20 s, a save linked itself to the network of its first mission, and the Bridge ran whichever connections were started by hand on one shared folder. In Tim's test of 10-10-2026 a save linked to network A asked for a mission while the Bridge ran network B: B made a mission the game ignored, and nothing said why.

**Game heartbeat (game → Bridge).** The Mission Board writes `game-to-bridge/telemetry/heartbeat.json` every 5 seconds while a save is loaded, also while the game is paused: exactly `{ protocolVersion: 1, beat, saveId, mode, networkId?, boardVersion? }` (beat a number that goes up, saveId `save_[a-z0-9]{1,40}`, mode `sp` or `mp`, networkId `[A-Za-z0-9_-]{1,128}`: the network the save is linked to, missing while it is not linked). A heartbeat file changed in the last 15 seconds means a game is running (the Bridge reads the file time).

**The save chooses the network.** The desktop Bridge runs one connection at a time: the one whose network the heartbeat names. When the heartbeat names another save or network, the running connection finishes the call in flight and stops, then the right one starts. No connection for that network: nothing runs (state `no_connection`). An unlinked save: nothing runs (state `unlinked`); the game links it with its picker. No fresh heartbeat: nothing runs and no web calls are made (state `idle`). Connections have no Start or Stop button any more. A connection that cannot start (token, folder) is tried again after 30 seconds.

**Files routed by save.** The Bridge keeps a `saveId → networkId` map from heartbeats in `state/save-networks.json`. An outbound file that names a save (`payload.saveId`) is sent only by the connection of that save's network. A file for a save linked to another network, or for a save the Bridge has not seen in a heartbeat, waits in `game-to-bridge/pending`; it is never sent to whichever network happens to run. Files without a saveId belong to the save being played. Mission and message files for another save already wait in `bridge-to-game/pending` (the game ignores other saves).

**Mission requests name the network.** `mission_request` may carry `payload.networkId` (same pattern). When it differs from the running connection's network, the Bridge does not post it: it writes `knox_request_status.json` with `status` `refused`, `reason` `wrong_network` and a message naming the connection, and archives the file. Bridges before 0.3.0 move a request with `networkId` to `failed`, so the Mission Board adds it only after it has seen a 0.3.0 heartbeat.

**Bridge heartbeat (Bridge → game).** The Bridge writes `bridge-to-game/pending/knox_bridge.json` (atomically) every 3 seconds and at once when something changes, also while idle: `{ protocolVersion: 1, beat, bridgeVersion, state, saveId?, networkId?, activeNetworkId?, activeName?, message?, connections }`. PZ Lua cannot read file times, so the game watches `beat`: no change for 15 seconds means the Bridge is off. `state`: `idle` (no game seen), `unlinked`, `no_connection`, `active` (`activeNetworkId` and `activeName` name the connection that runs for `saveId`), `error` (the connection for this save cannot start; `message` says why, up to 200 characters) and `stopped` (written once when the Bridge closes, so the game knows at once). `connections`: `{ networkId, name }` for each network with a connection (name up to 80 characters), for the in-game link picker.

**Game ended (Bridge 0.3.2).** When the heartbeat of a save that ran a connection stops (no fresh heartbeat, or another save is loaded), that connection sends one `knoxMissionSync` call after its last calls: exactly `{ protocolVersion, connectorVersion, networkId, action: "game_ended", saveId }`. The backend answers exactly `{ ok: true, protocolVersion: 1, saveId, sessionOpen }`, marks the network as seen with the game ended (`bridge.gameEndedMs`), and closes the save's play session 5 minutes later unless game data comes first (a quick quit and reload stays one session); the recap follows. A failure (an older backend answers HTTP 400) is only logged: the backend still closes a session after 20 idle minutes. Not sent for older Mission Boards (no heartbeat) or when the Bridge itself closes.

**Bridge last seen (backend, 12-10-2026).** Every authenticated `knoxMissionSync` call marks the network doc's `bridge.lastSeenMs`, at most every 5 minutes; the webapp shows "Playing now", "Game closed 12m ago" or "Bridge last seen 3h ago". No extra calls: without a game the Bridge stays silent.

**Older Mission Boards** (no heartbeat): when `telemetry/current.json` changed in the last 30 seconds and there is no heartbeat file (or only one much older than the telemetry), the Bridge runs the connection of the snapshot's save from the map, else the last network it ran, else the only connection, and sends every file as before 0.3.0.

## Experimental global audio test (Bridge 0.2.8)

The Development tab generates a new WAV and queues it for the selected Knox network. The
Bridge pulls it from the authenticated `knoxAudioSync` endpoint, validates the exact
response envelope, base64 payload, RIFF/WAVE header, 1.5 MB size cap, and SHA-256, then
atomically writes `bridge-to-game/pending/audio_<audioId>.json` plus the
`knox_audio.json` index. It acknowledges local queueing only after both files exist. This
does not confirm playback. The Connector server distributes the clip to currently
connected clients; client Java Sound playback remains an unverified in-game probe.

## File writes and clean-up (Bridge 0.2.6+)

- **Atomic writes.** Every file the Bridge writes for PZ (missions, the index, acknowledgements) goes to a temporary name that is unique per write and never ends in `.json`, then is renamed into place, so PZ sees the old file or the whole new one. Windows refuses the rename while another program has the target open (PZ reading the index); the Bridge retries a locked rename a few times (25–150 ms apart). A failed write removes its temporary file, so a leftover can never block later writes.
- **Old `ack_` files.** PZ Lua cannot delete files, so every connector test left an `ack_evt_*.json` behind in `bridge-to-game/pending`. At start and then every ten minutes the Bridge removes the ones older than a day (`acknowledgementMaxAgeMs`, default 24 hours). PZ reads its acknowledgement within seconds, so an old one is never needed again.
