# Personal Agent Operations Calendar Design

**Date:** 2026-07-13
**Status:** Ready for user review
**Scope:** Single-user personal product using the owner's Mac mini Hermes runtime

## 1. Product Goal

Build a personal agent operations calendar where autonomous agents can create useful work under a user-defined mission, place that work on a shared calendar, execute it through the existing Mac mini Hermes runtime, and report evidence-backed results and follow-up proposals to the user.

The product is not a generic AI calendar, an Obsidian replacement, or an agent chat interface. Its purpose is to make autonomous agent work visible, bounded, accountable, and useful.

## 2. User Problem

The owner already has specialized agents, a calendar, a private wiki, local LLM/RAG, and Telegram. Those pieces work individually, but the owner still has to:

- remember when an agent should work;
- repeatedly write prompts and provide context;
- decide which intermediate work is required;
- check whether the agent is still running or blocked;
- move outputs into the wiki;
- create the next task manually; and
- infer whether the agent's repeated work is producing value.

The resulting coordination cost prevents agents from becoming dependable ongoing workers.

## 3. Product Promise

> Give an agent a mission once. It creates the work required to advance that mission, shows the plan and execution on the calendar, and reports what changed, what it produced, and what it proposes to do next.

The calendar answers four questions:

1. What did the agent decide to do?
2. When will it do the work?
3. What is happening now, including failures and blocks?
4. What useful result did the user receive?

## 4. Positioning

Motion and Reclaim already focus on optimizing human tasks and flexible time on a calendar. Notion Agents already support scheduled or triggered agent workflows and external agents in a shared work surface. Agent Calendar therefore must not compete as another automatic scheduler or generic agent builder.

Its focused position is a personal operations and accountability layer for autonomous agents:

- mission contracts instead of one-off prompts;
- agent-generated work made visible on a real calendar;
- explicit limits on time, runs, data, and external actions;
- evidence-backed reports and follow-up proposals;
- private Hermes, local LLM, and wiki integrations for the owner's workflow.

References:

- [Motion AI Calendar](https://www.usemotion.com/)
- [Reclaim Habits](https://help.reclaim.ai/en/articles/4129152-habits-overview-auto-schedule-flexible-time-for-your-routines)
- [Notion Custom Agents](https://www.notion.com/product/agents)
- [Notion External Agents](https://www.notion.com/releases/2026-07-01)

## 5. First User And First Mission

The first user is the owner. Multi-user onboarding, hosted agents, and generalized cloud RAG are intentionally deferred.

The first mission template is **Weekly Opportunity Brief**:

- Mission: identify opportunities relevant to the owner's current business and product work.
- Success criteria: three evidence-backed opportunities and one recommended next move.
- Report cadence: every Friday at 16:00 Asia/Seoul.
- Weekly budget: at most six agent runs and 120 minutes of total runtime.
- Allowed actions: read approved wiki context, search approved external sources, create internal calendar work, write a report, and propose follow-up tasks.
- Forbidden actions: publish externally, send messages to third parties, make purchases, place trades, modify credentials, or delete source material.
- Primary agent: `bizconsultant`.
- Supporting context: the configured local wiki and prior mission reports.

The first successful week ends when the user receives the report without writing another prompt, marks it useful, and approves or rejects one follow-up proposal.

## 6. Core Domain Objects

### Mission

A durable outcome that gives agent work a reason to exist.

Required fields:

- title and objective;
- success criteria;
- owner agent;
- report cadence and timezone;
- active date range;
- autonomy policy;
- approved sources;
- status: `draft`, `active`, `paused`, `completed`, or `failed`.

### Autonomy Policy

The contract that bounds self-generated work.

Required fields:

- allowed action classes;
- forbidden action classes;
- run-count budget;
- runtime budget;
- external side-effect approval requirement;
- task approval mode;
- stop conditions;
- report format.

The initial mode is progressive autonomy:

- the first plan and every new task class require approval;
- the user may mark a task class as trusted;
- trusted internal tasks may be scheduled automatically;
- external side effects always require explicit approval.

### Agent Task

A bounded unit of work created by the user or an agent.

Every agent-generated task must include:

- mission ID;
- creating agent ID;
- reason for creation;
- expected output;
- scheduled start and due time;
- required sources and action class;
- estimated runtime and run cost;
- approval state;
- execution state;
- linked task session ID;
- linked run IDs and report ID.

Task states are `proposed`, `approved`, `scheduled`, `running`, `blocked`, `completed`, `failed`, and `cancelled`.

### Agent Session

A persistent, user-visible conversation and event stream for understanding and steering agent work.

The session hierarchy has two levels:

- a Mission Thread retains the mission objective, policy, report history, user feedback, and long-running conversation context;
- each Agent Task owns a Task Session beneath that Mission Thread, with the task plan, execution runs, tool activity, interventions, artifacts, errors, and completion result.

Task Session event types are `agent_message`, `user_message`, `plan`, `tool_activity`, `progress`, `approval_request`, `approval_response`, `artifact`, `error`, and `completion`.

The user can send a message, answer a question, adjust direction, attach approved context, approve an action, pause, resume, cancel, or retry from the Task Session. User interventions are persisted and become part of the task's execution context.

Sessions expose structured task rationale and summarized tool activity. They do not expose model chain-of-thought, secrets, raw authentication material, private absolute paths, or unredacted low-level logs.

### Report

The user-facing accountability artifact.

Every report contains:

- mission objective recap;
- work performed;
- new findings and changes since the previous report;
- produced artifacts;
- evidence and source links;
- unresolved assumptions and failures;
- budget consumed;
- next-task proposals with reasons;
- user usefulness feedback.

### Execution Provider

The runtime adapter that performs an approved task. The personal MVP has one provider: the existing remote Mac mini Hermes relay. The contract remains provider-neutral so a hosted executor can be added later without changing missions, tasks, calendar states, or reports.

## 7. Primary Product Views

### Calendar

The primary operational timeline combines user events and agent work.

Agent work is visually distinct by state:

- proposed: amber dashed item;
- approved or scheduled: blue item;
- running: blue item with active progress;
- report ready or completed: green item;
- blocked or failed: red item with the cause and next action.

Calendar items show the responsible agent, mission, expected output, and report deadline. Filters allow `Me`, `Agents`, and `Combined` views. Agent tasks must retain stable dimensions so progress and status changes do not shift the calendar layout.

### Missions

Missions define why an agent works. The mission detail shows objective, success criteria, owner agent, autonomy limits, sources, budget usage, current plan, report schedule, and pause/stop controls.

Pausing a mission persists the mission as `paused` and requests pause for scheduled or running work. Stopping a mission persists it as `cancelled` and cancels all remaining work; a running Hermes completion applies that request at its next checkpoint.

### Agents

Agents remain visible and useful, but are described by user outcomes rather than runtime implementation. Each agent shows:

- role and supported work;
- connected execution provider;
- online and blocked state;
- active missions and current load;
- trust level and allowed task classes;
- recent reports and usefulness rate.

Hermes profile names are available in the personal advanced details, but mission creation does not require writing a raw Hermes command or prompt.

### Sessions

Sessions provide the detailed operational view comparable to a Codex task conversation. A Task Session opens from its calendar item, mission plan, report evidence, or Telegram deep link.

The default layout contains:

- a left session list grouped under the active mission;
- a central chronological conversation and execution transcript;
- a right task-contract panel showing mission, expected output, calendar time, budget, sources, artifacts, and current state;
- controls for approval, pause, resume, cancel, retry, and user messages.

Tool activity is summarized into user-meaningful checkpoints with expandable sanitized details. The transcript must be derived from persisted execution events and must never fabricate progress messages.

### Reports

Reports provide an inbox ordered by due time and unread state. A report opens with the result first, followed by evidence, execution details, limitations, and proposed follow-up work.

The user can approve or reject each follow-up proposal. The decision is persisted on the report, appended to the linked Task Session, and supplied to the next mission-planning cycle. Approval does not fabricate an immediately scheduled task when the proposal lacks a reviewed schedule or output contract.

For the first implementation, Missions, Agents, and Reports may be tabs within the existing Agent workspace rather than three new global navigation items.

### Wiki

The existing wiki remains the private context and artifact store. It is not redesigned as the primary product surface in this phase.

Mission and report screens link to relevant wiki evidence. Approved final reports may be written into the configured wiki through the existing safe path boundary.

## 8. End-To-End Flow

1. The user creates the Weekly Opportunity Brief mission from a template.
2. The user reviews objective, sources, budget, report cadence, and forbidden actions.
3. The `bizconsultant` agent generates a structured weekly plan with two to five tasks.
4. The system validates every task against the autonomy policy and budget.
5. Proposed tasks appear as amber dashed calendar items with creation reasons.
6. Each proposed task receives a Task Session under the mission's persistent Mission Thread.
7. The user approves the first weekly plan.
8. Approved tasks become scheduled calendar items and launch through the Mac mini relay at their scheduled time.
9. Run progress, summarized tool activity, questions, user interventions, artifacts, and errors append to the Task Session and update the calendar without claiming false completion.
10. The user can open the Task Session from the calendar to observe or steer the work while it is active.
11. Completed task artifacts and evidence are accumulated under the mission.
12. At the report deadline, the reporting step produces the structured weekly report.
13. The report appears on the calendar, in Reports, and as a Telegram summary with a link to the full result and relevant Task Sessions.
14. The user marks the report useful or not useful and approves, edits, or rejects follow-up tasks.
15. The next weekly plan uses the previous report, session interventions, and user feedback as context while remaining within the same autonomy contract.

## 9. Meaningful Self-Generated Work Rules

An agent may create a task only when all conditions are true:

- the task advances an active mission success criterion;
- the agent records why the task is necessary now;
- the expected output is concrete and reviewable;
- the task has a scheduled time and report relationship;
- the required action class and sources are allowed;
- the remaining mission budget can cover the estimate;
- an equivalent active task does not already exist.

The system rejects or holds tasks that are unrelated, duplicate, open-ended, over budget, missing an expected output, or requesting forbidden side effects.

Agents cannot create new missions in the personal MVP. They may only propose follow-up tasks inside an existing mission.

## 10. Execution And Scheduling Architecture

The existing Railway gateway remains the control plane and the Mac mini Hermes runtime remains the execution plane.

Required runtime flow:

1. The scheduler selects an approved due Agent Task.
2. The gateway creates an idempotent execution request tied to mission and task IDs.
3. The Railway relay forwards the request to the registered Mac mini runtime.
4. The runtime selects the task's Hermes profile and executes it with the allowed context.
5. Progress events append to the linked Task Session and update the Agent Task and calendar event.
6. Completion stores the structured result and evidence references.
7. Failure stores an explicit reason and leaves enough state for safe retry.

The gateway must not silently switch to another profile or execution provider. A Mac mini outage produces a blocked state and deadline-risk warning.

## 11. Data And Privacy Boundaries

This phase remains single-user, so no new multi-tenant migration is included.

Private data rules remain:

- local wiki files and embeddings stay on the owner's device;
- safe path validation protects wiki reads and writes;
- Railway stores mission, task, status, report metadata, and the report content needed by the app;
- raw local paths, model credentials, runtime tokens, and unrelated wiki content are never exposed in client responses;
- session transcripts contain sanitized user-facing events rather than hidden model reasoning or unredacted process output;
- Telegram receives the report summary and app link, not the full private evidence bundle;
- secrets remain redacted in settings and logs.

## 12. Error Handling And Recovery

### Mac mini or relay offline

- due work becomes `blocked`, not `running`;
- the UI shows the last heartbeat, affected task, and report deadline risk;
- reconnecting resumes only work that still owns a valid execution lease;
- retries use the same idempotency key and cannot duplicate a completed run.

### Runtime restart

- persisted `running` work without an active runner becomes `failed` with an interruption reason;
- the user can retry from the failed task;
- completed reports and artifacts remain intact.

### Insufficient evidence

- the agent reports the evidence gap;
- it may propose one bounded follow-up task or one user question;
- it cannot label an unsupported conclusion as complete.

### Budget exhausted

- remaining work is paused;
- the report contains partial results and the consumed budget;
- increasing the budget requires user approval.

### Calendar change

- moving the report deadline causes a replan proposal;
- completed work is retained;
- scheduled but unstarted tasks are moved only when the revised plan remains within the mission policy.

## 13. MVP Scope

The personal MVP includes:

- one owner user;
- the existing Mac mini Hermes relay;
- the existing `bizconsultant`, `stockagent`, `uniportpm`, and `wikicurator` profiles;
- mission creation from the Weekly Opportunity Brief template;
- structured agent plan generation;
- progressive task approval;
- agent-generated tasks on the calendar;
- scheduled execution and truthful runtime states;
- persistent Mission Threads and Task Sessions with user-visible execution details and intervention controls;
- structured reports with evidence and follow-up proposals;
- Telegram summary reporting;
- usefulness feedback and mission pause/stop controls.

## 14. Non-Goals

This phase does not include:

- multi-user accounts or workspace isolation;
- public signup, billing, plans, or quotas;
- a hosted agent runtime;
- public agent creation or an agent marketplace;
- team collaboration and role permissions;
- autonomous email, posting, purchases, trades, or external writes;
- replacing the existing wiki with a generalized knowledge product;
- supporting arbitrary user-installed agent runtimes;
- unlimited self-generated work.

## 15. Success Metrics

The North Star metric is:

> Weekly reports the owner opened and marked useful.

Supporting metrics are:

- mission activation rate;
- proposed task approval rate;
- trusted task-class promotion rate;
- on-time task and report completion rate;
- blocked-work recovery rate;
- report usefulness rate;
- follow-up proposal approval rate;
- average runtime and run count per useful report.

The product is not successful merely because agents run often. Runs without useful reports are a cost and quality failure.

## 16. Verification Strategy

Implementation follows repository TDD rules.

Required verification layers:

- unit tests for mission policy validation, budget checks, task state transitions, and report shape;
- backend contract tests for mission, task, report, scheduler, and relay routes;
- Electron/preload contract tests for any new desktop boundary;
- session ordering, persistence, redaction, and intervention contract tests;
- Playwright workflow for mission creation, plan approval, calendar visualization, report opening, follow-up approval, pause, and failure display;
- Playwright workflow that opens a calendar task session, observes persisted execution events, sends a user instruction, pauses or resumes work, and returns after reload to the same transcript;
- a real Mac mini harmless mission run that creates a task, appears on the calendar, completes, and produces a report;
- a real offline/restart scenario that shows blocked or failed state without false completion;
- full backend tests, desktop tests, typecheck, build, and relevant Playwright gates.

## 17. Acceptance Gates

The personal MVP is complete only when:

1. The user can create and activate the Weekly Opportunity Brief mission.
2. The agent creates a bounded weekly plan with reasons and expected outputs.
3. Proposed work is visibly distinct on the calendar.
4. First-week tasks require approval and trusted task classes can later auto-schedule.
5. Approved tasks execute through the correct Mac mini Hermes profile.
6. Every Agent Task has a persistent Task Session that opens from the calendar and shows ordered plan, progress, tool activity, questions, artifacts, errors, and completion events.
7. The user can message, approve, pause, resume, cancel, and retry through the Task Session, and the resulting intervention survives reload.
8. Session responses redact secrets, private paths, hidden model reasoning, and unapproved raw logs.
9. Calendar states match persisted task, session, and run states after reload.
10. The Friday report includes findings, evidence, limitations, budget usage, follow-up proposals, and links to relevant Task Sessions.
11. Telegram receives a concise report summary and session deep link.
12. The user can mark the report useful and approve or reject follow-up work.
13. Offline, restart, budget, and insufficient-evidence states are visible and recoverable.
14. No task can exceed its mission policy or perform a forbidden external action.

## 18. Rollout And Future Extension

The rollout is personal dogfooding first:

1. Run Weekly Opportunity Brief for two consecutive weeks.
2. Review every generated task and report for usefulness and unnecessary work.
3. Promote only repeatedly useful task classes to automatic approval.
4. Record execution cost, missed deadlines, and intervention frequency.
5. Decide whether the validated workflow merits a hosted executor and multi-user product.

Future multi-user work must preserve the domain contracts in this design while adding workspace ownership, hosted execution providers, connector registration, quotas, billing, and tenant isolation. Those concerns are deferred and must not complicate the personal implementation.

## 19. Remaining Risks

- The installed Mac mini runtime is not currently source-controlled with the application, so runtime updates can overwrite operating fixes.
- The `bizconsultant` agent may create plausible but low-value work unless task reasons, expected outputs, evidence, and feedback are enforced structurally.
- Long-running local execution can miss report deadlines when the Mac mini or network is unavailable.
- Calendar density can become noisy unless proposed work, active work, and reports remain visually distinct and filterable.
- Long session transcripts can become noisy or leak sensitive tool output unless events are summarized, redacted, and grouped by checkpoint.
- Telegram reports can leak sensitive context if summaries are not deliberately minimized.
