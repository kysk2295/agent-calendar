# Agent Calendar Domain Context Map

Agent Calendar is divided by business capability. Frameworks and deployment tiers may implement a context, but they do not define it.

- **Work Management** — personal tasks, calendar events, lists, tags, schedules, completion, and time-based summaries.
- **Agent Work** — Delegated Work, its Work Conversation, subordinate tasks, Task Sessions, interventions, revisions, and results.
- **Knowledge** — documents, wiki material, journals, retrieval, citations, and knowledge graphs.
- **Communication** — Calendar AI Conversation, mail, Telegram ingress, and result delivery.
- **Automation** — recurring jobs, schedules, activation state, and due-work evaluation.
- **Platform** — identity, Workspace ownership, Runner Enrollment, settings, deployment status, persistence adapters, execution engines, Runtime, and Relay connectivity.

Dependencies point from product-facing contexts toward Platform interfaces. Platform implementation details must not define the language or state transitions of the other contexts.

Every product-facing request enters with an authenticated User and WorkspaceScope. Platform may
route a local capability to a Runner enrolled in that Workspace, but no context may select a
global or another Workspace's Runner.

Calendar AI Conversation is owned by Communication. It composes Work Management schedule
queries and changes, Agent Work delegation and intervention, Knowledge retrieval, and Automation
changes through those contexts' Interfaces. Communication owns the conversation and action
receipts; it does not own or copy their source truth.

## Desktop implementation map

| Context | Pure domain rules | React feature surface | Composition owner |
| --- | --- | --- | --- |
| Work Management | `apps/desktop/src/domains/work-management/` | Calendar, task, taxonomy surfaces currently composed in `App.tsx` | `apps/desktop/src/App.tsx` |
| Agent Work | `apps/desktop/src/domains/agent-work/` | `apps/desktop/src/features/agent-operations/` | `apps/desktop/src/App.tsx` |
| Knowledge | `apps/desktop/src/domains/knowledge/` | `apps/desktop/src/features/knowledge/` | `apps/desktop/src/App.tsx` |
| Communication | `apps/desktop/src/domains/communication/` | `apps/desktop/src/features/communication/` | `apps/desktop/src/App.tsx` |

The desktop dependency direction is:

`App composition -> feature surface -> pure domain rules`

- Domain modules do not import React, the API client, Electron, or `App.tsx`.
- Feature modules receive mutations and remote loaders through typed props. They do not import `App.tsx` or the API client.
- `App.tsx` owns cross-context hydration, remote invocation, persistence callbacks, navigation, and application-level state.
- Communication ingress implemented by Telegram remains a backend boundary; the desktop Communication domain owns mail and Calendar AI Conversation behavior, not schedule, work, knowledge, or automation source truth.
