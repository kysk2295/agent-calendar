# Agent Calendar

Agent Calendar is a calendar-first operations context for scheduling, delegating, observing, reviewing, and steering accountable agent work.

## Language

**Workspace (작업공간)**:
The ownership and isolation context containing one operator's calendars, knowledge, Delegated Work, automations, policies, and Runner connections. The first production release presents one operator per Workspace without making global or cross-workspace state part of the product model.
_Avoid_: User database, global state, account

**Unified Calendar (통합 캘린더)**:
The primary timeline combining a user's external schedule with independently running agent work and automation occurrences. Human and agent entries may overlap because they do not compete for the same time resource.
_Avoid_: Human-resource optimizer, conflict-free scheduler

**Calendar AI (캘린더 AI)**:
The Workspace-owned conversational counterpart that answers from currently authorized schedules and knowledge, talks naturally, and turns explicit requests into calendar changes, Delegated Work, or Connected Automation changes.
_Avoid_: Schedule search, omniscient chatbot, direct database agent

**Personal Memory (개인 기억)**:
User-visible facts and preferences deliberately retained for Calendar AI across conversations, with provenance and deletion. Calendar entries remain source truth and are never replaced by remembered copies.
_Avoid_: Hidden profile, raw conversation archive, calendar cache

**Agent Work Control Space (에이전트 작업 관제 공간)**:
The product surface where a user delegates agent work, observes its state, reviews its outcome, and intervenes when necessary.
_Avoid_: Agent chat, chatbot

**Control Home (관제 홈)**:
The default view of the Agent Work Control Space when no Delegated Work is selected, summarizing work that needs attention and offering a clear way to begin new work.
_Avoid_: Dashboard as the permanent work surface

**Work Conversation View (작업 대화 화면)**:
The primary workspace for one selected Delegated Work, centered on its Work Conversation with supporting details available without displacing the conversation.
_Avoid_: Drawer, report viewer

**Delegated Work (위임 작업)**:
One outcome-oriented request entrusted by the user to an agent. A Delegated Work owns one Work Conversation and may contain multiple subordinate tasks.
_Avoid_: Chat, individual task

**Responsible Agent (담당 에이전트)**:
The visible agent accountable for one Delegated Work. In the current release, the system assigns it from the requested outcome unless the user names an explicit advanced override while delegating. Reassigning existing work is deferred; the visible assignment and reason remain the accountability record.
_Avoid_: Model, execution engine

**Execution Engine (실행 엔진)**:
The runtime mechanism used to perform work. A requested automatic choice or explicit advanced override is retained, while the actual resolved engine is shown only when execution evidence supplies it. Engine details remain secondary to the Responsible Agent.
_Avoid_: Responsible agent, required choice before delegation

**Runner (러너)**:
A customer-controlled execution host enrolled in exactly one Workspace that connects one or more Execution Engines, receives only that Workspace's work, and returns execution evidence. Provider credentials remain under the customer's control rather than becoming Agent Calendar credentials.
_Avoid_: Execution engine, model, central server, global worker pool

**Runner Enrollment (러너 등록)**:
The account-authorized, owner-confirmed act that binds a customer-controlled host and its verified public identity to exactly one Workspace, producing a revocable Runner identity.
_Avoid_: Login, reusable pairing link, shared Runner secret

**Connected Automation (연결 자동화)**:
An automation that remains scheduled and executed by its source system while Agent Calendar projects and manages it through a common calendar and control interface.
_Avoid_: Copied automation, migrated job

**Automation Change Policy (자동화 변경 정책)**:
The Workspace rule that determines which automation creations or edits may be applied directly and which require an Approval Gate. New permissions, additional cost, and new external delivery always require approval.
_Avoid_: Blanket autonomy, approval for every edit

**Work Conversation (작업 대화)**:
A conversation attached to one Delegated Work from initial delegation through planning, execution, failure, completion, and subsequent revision. Messages are operational inputs that can affect the work in every state, not comments attached to a formal report.
_Avoid_: Free chat, general chat, report comments

**Intervention (개입)**:
A user instruction that changes the direction, state, or output of a Delegated Work. Safe internal interventions and already-supported consequential actions follow their existing executable policy. Unsupported external send, publish, purchase, or delete requests are rejected and recorded as blocked without an approval action.
_Avoid_: Comment, passive feedback

**Approval Gate (승인 관문)**:
An explicit user decision required by an already-supported executable action's policy. An Approval Gate never turns an unsupported external request into an executable action.
_Avoid_: Confirmation for every message, blanket approval

**Work Checkpoint (작업 체크포인트)**:
A user-meaningful change in a Delegated Work, such as a plan, approval request, progress milestone, blocker, artifact, or result. Work Checkpoints belong in the Work Conversation; raw tool activity does not.
_Avoid_: Raw log, heartbeat, status noise

**수정 차수**:
A new attempt within the same Delegated Work to revise its existing outcome. Earlier results remain part of the Work Conversation while one result is identified as current.
_Avoid_: New work, overwritten result

**Follow-up Work (후속 작업)**:
A separately and explicitly created Delegated Work for a supported goal that differs materially from the source work. In the current release, the system returns `follow_up_required` and asks the user to create new work; it does not create or link Follow-up Work automatically. Visible relationship creation is deferred. Unsupported external actions remain rejected rather than becoming Follow-up Work.
_Avoid_: Revision, continuation of the same result
