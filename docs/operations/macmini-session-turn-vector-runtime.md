# Mac mini Direct Wiki Curator Runtime

## Runtime boundary

- Dashboard API `127.0.0.1:9121` is the control/read plane for sessions,
  profiles, scheduler jobs, and health. It does not execute curator turns.
- Curator Gateway API `127.0.0.1:8643` owns the persisted `wikicurator`
  Agent API session and serves `/api/sessions/{id}/chat/stream` directly.
- Ollama `127.0.0.1:11434` owns calendar synthesis (`qwen2.5:7b`) and wiki
  evidence embeddings (`bge-m3`).
- Railway enqueues `agent.chat` and `wiki.search` in parallel. The curator
  answer is returned unchanged; vector results are rendered only as evidence.
- Telegram sessions, Telegram delivery, and Telegram-selected routes do not
  participate in the desktop Wiki AI request path.

## Deployed artifacts

- Relay bridge:
  `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`
- Relay tests:
  `/Users/goyunseo/.hermes/os-runtime/tests/railway-relay-profile-chat.test.js`
- Curator Gateway runtime:
  `/Users/goyunseo/.hermes/hermes-agent/gateway/platforms/api_server.py`
- Curator profile config:
  `/Users/goyunseo/.hermes/profiles/wikicurator/config.yaml`
- Vector index:
  `/Users/goyunseo/.hermes/cache/agent-calendar-wiki-vectors.json`
- LaunchAgents:
  `com.yunseo.hermes-railway-relay`, `ai.hermes.gateway-wikicurator`

The Relay directory is not a git checkout. Deployment-time backups are kept
next to the runtime files with timestamped `.backup-YYYYMMDDHHMMSS` suffixes.
The existing Hermes Agent API is reused; no Telegram-capture fork is required
for desktop Wiki AI execution.

## Behavioral contracts

- Backend sends only `profile`, the unchanged user `message`, `requestId`, and
  a stable desktop `conversationId`; retrieval chunks are never inserted into
  the Agent request.
- Relay ensures the persisted API session exists, then calls
  `/api/sessions/{conversationId}/chat/stream` with the unchanged user message.
- The API request uses a separate read-only Q&A system instruction: do not load
  skills, do not mutate files, inspect only relevant wiki files, answer in
  natural Korean, and say when evidence is insufficient.
- Relay has a reserved `agent.chat` lane and three general job lanes.
- Curator deltas are coalesced before Railway callbacks; a stalled
  non-terminal callback cannot block the terminal event.
- Known provider/rate-limit/authentication messages are typed failures and are
  never promoted to `answerMode: llm`.
- The `wikicurator` profile is pinned to `openai-codex` / `gpt-5.5`, has no
  provider fallback chain, and exposes only the `file` toolset to API-server
  Q&A turns. The Relay hard timeout is 60 seconds.
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
2. Replace the `wikicurator` profile config with the matching timestamped
   backup.
3. Restart `ai.hermes.gateway-wikicurator` and
   `com.yunseo.hermes-railway-relay` with `launchctl kickstart -k`.
4. Confirm the public path returns an explicit degraded response; never expose
   raw prompts or keyword results as a curator answer.
