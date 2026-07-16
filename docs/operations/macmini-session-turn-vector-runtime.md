# Mac mini Wiki Session Turn Runtime

## Runtime boundary

- Dashboard API `127.0.0.1:9121` is the control/read plane for sessions,
  profiles, scheduler jobs, and health. It does not execute curator turns.
- Curator Gateway API `127.0.0.1:8643` owns the active Telegram
  `wikicurator` route and serves capture-only session turns.
- Ollama `127.0.0.1:11434` owns calendar synthesis (`qwen2.5:7b`) and wiki
  evidence embeddings (`bge-m3`).
- Railway enqueues `session.turn` and `wiki.search` in parallel. The curator
  answer is returned unchanged; vector results are rendered only as evidence.

## Deployed artifacts

- Relay bridge:
  `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`
- Relay tests:
  `/Users/goyunseo/.hermes/os-runtime/tests/railway-relay-profile-chat.test.js`
- Curator Gateway runtime:
  `/Users/goyunseo/.hermes/hermes-agent/gateway/run.py`
- Vector index:
  `/Users/goyunseo/.hermes/cache/agent-calendar-wiki-vectors.json`
- LaunchAgents:
  `com.yunseo.hermes-railway-relay`, `ai.hermes.gateway-wikicurator`

The Hermes changes are committed locally on branch
`codex/remote-deploy-integration` in commits `6975cec2e` and `330f8c93f`.
The Relay directory is not a git checkout. Deployment-time backups are kept
next to the runtime files with suffixes `.serial-backup`,
`.delta-batch-backup`, `.vector-backup`, and `.warm-backup`.

## Behavioral contracts

- Capture uses the latest active Telegram DM route and at most 40 plain
  user/assistant messages.
- Capture uses an ephemeral agent with no session DB, memory write, file
  transcript write, Telegram delivery, or mutation of the active session.
- Relay has a reserved `session.turn` lane and three general job lanes.
- Curator deltas are coalesced before Railway callbacks; a stalled
  non-terminal callback cannot block the terminal event.
- Wiki evidence uses a persistent 1024-dimensional `bge-m3` vector index.
  Changed or missing notes are embedded in batches of at most 64.
- `bge-m3` requests use `keep_alive: 0`. The Relay warms `qwen2.5:7b` before
  polling, refreshes it hourly, and pins it for 24 hours on calendar requests.

## Verification

Run the Relay suite on the Mac mini:

```sh
cd /Users/goyunseo/.hermes/os-runtime
HOME=/Users/goyunseo /Users/goyunseo/.local/bin/node --check scripts/hermes-railway-relay-bridge.js
HOME=/Users/goyunseo /Users/goyunseo/.local/bin/node --test tests/railway-relay-profile-chat.test.js
```

Expected live metadata for a wiki turn:

```json
{
  "answerMode": "llm",
  "llm": { "provider": "openai-codex", "model": "gpt-5.5" },
  "retrieval": {
    "source": "wiki-vector-index",
    "mode": "vector-hybrid",
    "embeddingModel": "bge-m3",
    "indexComplete": true
  }
}
```

Expected live metadata for a calendar turn:

```json
{
  "answerMode": "llm",
  "llm": { "provider": "local-llm", "model": "qwen2.5:7b", "used": true }
}
```

## Rollback

1. Replace the active Relay script and test with the matching adjacent backup.
2. Replace `gateway/run.py` with `gateway/run.py.capture-history-backup` or
   `gateway/run.py.capture-isolation-backup` depending on the rollback point.
3. Restart the matching LaunchAgent with `launchctl kickstart -k`.
4. Confirm the public path returns an explicit degraded response; never expose
   raw prompts or keyword results as a curator answer.
