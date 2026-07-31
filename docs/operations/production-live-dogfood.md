# Production live dogfood

This checklist closes only the manual, external part of the production-auth first-user
journey. It requires a real WorkOS AuthKit tenant, real Google Calendar consent, a
customer-controlled Runner, and a real execution engine. Injected adapters, fake engines,
`WORKSPACE_AUTH_MODE=legacy`, or a previously populated Workspace do not satisfy it.

Run the checklist against the approved isolated staging candidate first. Repeat it against
the exact production candidate only after the staging and release gates in
[`production-launch-readiness.md`](../plans/2026-07-31-production-launch-readiness.md)
authorize promotion. A pass is evidence for this candidate and this test Workspace only;
it is not a public or multi-tenant launch claim.

## Stop rules

Stop and record `FAIL` or `BLOCKED` if any of these is true:

- the Desktop build, gateway deployment, or source commit differs from the reviewed candidate;
- the gateway is not configured with `WORKSPACE_AUTH_MODE=production`;
- anonymous product reads do not fail closed with `401 workspace_auth_required`;
- the login uses an injected AuthKit adapter or a non-live tenant;
- Google OAuth is missing its production client, redirect, encryption vault, or explicit enablement;
- the Runner challenge or device fingerprint does not match, the Runner is disconnected,
  or no real engine is installed and authenticated on that host;
- the new Workspace shows invented default, business, stock, project, or Wiki agents;
- any step would require recording or sharing a secret.

Do not switch to `WORKSPACE_AUTH_MODE=legacy` to finish the run. Do not deploy, roll back,
publish, send externally, purchase, or delete data as part of this checklist.

## Secret-free evidence rules

Evidence may contain the environment name, full candidate commit, deployment ID, Desktop
build ID, Runner version, timestamps, bounded pass/fail booleans, redacted screenshot
filenames, and screenshot hashes.

Never retain or paste:

- WorkOS or Google keys, OAuth authorization codes, verifier/state values, access/refresh
  tokens, cookies, request headers, browser URLs, or callback URLs with query strings;
- email, user/tenant/Workspace IDs, calendar names or event content;
- QR images or payloads, one-time codes, challenge IDs, device credentials, session IDs,
  Runner state directories, or provider credentials;
- Delegated Work prompt/output content, raw tool logs, or hidden reasoning.

The enrollment QR contains the live base URL, challenge ID, and one-time code. Do not take
or retain a screenshot of it. If an otherwise useful screenshot contains identity,
calendar text, a fingerprint, prompt, or result, crop or redact it before hashing and
retention. Prefer the boolean evidence template below.

## Preconditions

### Candidate and service

- Record the reviewed full commit, deployment ID, Desktop build ID, Runner version, and
  exact HTTPS gateway origin without query parameters.
- Confirm `/api/gateway-status`, `/api/health`, and `/api/ready` are HTTP 200 and bound to
  the reviewed candidate using the release procedure in
  [`production-release-rollback.md`](production-release-rollback.md).
- Use a new operator-approved test account and an empty test Workspace. The account may
  be real, but its identity must not appear in retained evidence.
- Use an approved, isolated Desktop profile. Do not delete or overwrite an operator's
  existing profile to make it clean.

### Configuration presence

Confirm presence in the environment's secret manager without printing values:

| Area | Required configuration |
| --- | --- |
| Auth mode | `WORKSPACE_AUTH_MODE=production` |
| WorkOS | `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`; registered Desktop return `agent-calendar://auth/callback` |
| Google Calendar | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`; redirect matches `agent-calendar://calendar/google/callback` |
| Google token storage | `GOOGLE_CREDENTIAL_ENCRYPTION_KEY`, or a reviewed injected external vault with `GOOGLE_CREDENTIAL_VAULT=external` |
| Google surface | `UNIFIED_CALENDAR_EXTERNAL_ENABLED=1` or an equivalent truthy setting |
| Persistence | candidate-specific `DATABASE_URL` with reviewed migrations |

For a local live rehearsal, configure WorkOS with
[`local-workos-dogfood.md`](local-workos-dogfood.md), add the Google/vault variables to
the same process environment, and start with `npm run backend:start:workos`. For an
approved deployed candidate, inspect configuration presence in the provider console or
approved presence-only tooling. Do not use a command that dumps all environment values.

### Runner host

- The host clock is synchronized and can reach the exact HTTPS gateway origin.
- The approved Runner artifact is installed. A local checkout is rehearsal-only unless
  the release owner explicitly accepted it for the candidate.
- At least one real execution engine (Codex, Claude, Grok, or Hermes) is installed and
  authenticated on the Runner host. Provider credentials remain on that host.
- No fake engine flags or injected capability probes are present.

## Ordered live checklist

### 1. Bind the Desktop to the candidate

1. Launch the approved Desktop with the isolated profile.
2. Before login, confirm its API Base URL is the exact candidate origin. If using the
   development Desktop, use the in-app `설정` → `연결` → `API Base URL` field and choose
   `저장하고 재연결`; never edit another profile's settings file by hand.
3. In a separate safe terminal, make anonymous reads without credentials:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' "$GATEWAY_ORIGIN/api/agents"
   curl -sS -o /dev/null -w '%{http_code}\n' "$GATEWAY_ORIGIN/api/state"
   ```

Expected:

- both commands print only `401`;
- a bounded JSON inspection, if separately authorized, reports
  `workspace_auth_required` without returning product data;
- the Desktop shows `작업공간 로그인`, `Google 또는 이메일로 계속하기`, and the note
  that Google Calendar is connected later from the start guide.

Fail signals:

- either product read returns `200`, redirects to a legacy surface, or returns Workspace data;
- the API origin or deployment shown by the Desktop differs from the candidate;
- the app offers an in-app password form or asks for a Google password.

Evidence: record `anonymousAgents401=true`, `anonymousState401=true`, the candidate
identifiers, and the observation time. Do not retain response bodies or headers.

### 2. Complete live WorkOS AuthKit login

1. Select `Google 또는 이메일로 계속하기`.
2. Complete sign-in in the system browser with the approved real-tenant test account.
3. Allow the `agent-calendar://auth/callback` handoff to open the same Desktop instance.
4. Wait for the signed-in Workspace and the first-run `작업공간 준비` guide.

Expected:

- while waiting, the Desktop says `브라우저에서 Google 계정을 선택해 로그인을 완료하세요`;
- the system browser, not the renderer, owns credentials;
- the callback returns to the same Desktop, and the guide shows the actual readiness
  count (normally `0/4 준비` for a genuinely new Workspace).

Fail signals:

- `작업공간 로그인(AuthKit)이 아직 설정되지 않았습니다`, timeout, state mismatch,
  a callback opening another checkout/Desktop instance, or repeated login without a session;
- the test used an injected adapter, fixture account, or copied session;
- more than one Workspace requires selection; this release reports that path unsupported.

Evidence: record only `provider=workos_authkit`, `liveTenant=true`,
`injectedAdapter=false`, `desktopCallbackReturned=true`, and the initial readiness count.
Do not record the account, tenant, Workspace, browser URL, or callback parameters.

### 3. Verify empty Workspace honesty

1. Open `에이전트` / Control Home before creating or importing an agent.
2. Inspect both the left Responsible Agent directory and the Control Home summaries.

Expected:

- the directory says `이 Workspace에는 미리 연결된 에이전트가 없습니다.`;
- Control Home says `저장된 위임 작업이 없습니다.` and does not show a fabricated roster;
- Mode A and Mode B controls may be visible, but no named agent is silently preselected.

Fail signals:

- `default`, `bizconsultant`, `stockagent`, `uniportpm`, `wikicurator`, or another
  official-profile fallback appears without an explicit Workspace create/import action;
- another Workspace's agent, work, calendar, Runner, or identity is visible;
- an empty list is replaced by a demo/sample agent.

Evidence: record `initialAgentCount=0`, `initialDelegatedWorkCount=0`, and
`syntheticRosterObserved=false`. A cropped screenshot is optional only after account
identity and unrelated navigation content are removed.

### 4. Connect and sync real Google Calendar

1. Return to `작업공간 준비` and select `캘린더 동기화`.
2. Select `Google Calendar 연결` and grant only the reviewed Calendar scopes in the
   system browser. This consent is separate from WorkOS identity login.
3. Allow `agent-calendar://calendar/google/callback` to return to the same Desktop.
4. If the guide shows `동기화 필요`, select `지금 동기화`.
5. Open Calendar and confirm the source summary without opening private events.

Expected:

- the action says `브라우저 승인 대기 중…` while consent is pending;
- after callback, the Google source is `연결됨`;
- after sync, the guide says `동기화 완료` and Calendar says
  `Google Calendar 연결됨` with a non-empty last-synced observation;
- event titles, attendees, and descriptions are not needed for this gate.

Fail signals:

- `Google Calendar 연결을 사용할 수 없습니다. 관리자 설정을 확인하세요`, login
  required, timeout, state mismatch, redirect mismatch, consent denial, or repeated sync failure;
- source status remains disconnected or connected-without-sync;
- a Google connection from another Workspace appears.

Evidence: record `googleConsentCompleted`, `googleSourceConnected`,
`googleInitialSyncCompleted`, and `googleLastSyncPresent` as booleans. Do not record source
IDs, calendar names, event counts, or event content.

### 5. Enroll the Runner from the QR challenge

1. In the guide, select `Runner / 실행 컴퓨터` → `Runner 등록 시작`.
2. In `Runner 설정`, select `Runner 추가` → `일회용 코드 발급`.
3. Confirm the `3. 일회용 코드 · QR` screen renders a standards-compliant QR and a
   one-time code. Do not photograph, copy into evidence, or send either value.
4. Choose one enrollment transport and record it honestly:
   - `qr_scanner`: use the approved Runner build's QR-import surface. It must consume a
     payload whose kind is `agent-calendar-runner-enroll` without exposing it to evidence.
   - `displayed_challenge_cli`: if operating the repository CLI, enter the fields shown
     beside the QR on the Runner host. The CLI does not scan an image, so this proves live
     Runner enrollment but leaves the QR-scanner gate pending.
5. For the installed CLI, keep this process running through the Mode A test:

   ```bash
   agent-calendar-runner daemon \
     --base-url "$GATEWAY_ORIGIN" \
     --challenge-id "<shown only in the Desktop>" \
     --code "<shown only in the Desktop>"
   ```

   A local-checkout rehearsal can replace the binary with
   `node apps/runner/bin/agent-calendar-runner.js`. Do not use `--once`; Mode A requires
   the Runner to remain connected.
6. When the Desktop shows `4. 장치 지문 확인`, compare the entire fingerprint with the
   Runner host. Select `확인` only on an exact match; otherwise select `거부` and start over.
7. Wait for `상태: Connected`, select `연결 테스트`, and confirm `준비 완료`.
8. Confirm at least one intended engine reports installed and authenticated. If it says
   `Runner에서 로그인하세요`, authenticate on the Runner host and refresh state.

Expected:

- one pending device appears for the current Workspace;
- the confirmed fingerprint matches without transcription differences;
- the Runner reaches active/connected, the connection test passes, and the intended
  engine is authenticated on the host;
- provider credentials are never requested by Desktop.

Fail signals:

- QR is missing/unreadable, the challenge expires, multiple devices appear, or the
  fingerprint differs;
- status remains `Disconnected`/`Reconnecting`, `다시 연결 필요` appears, connection
  test is only historical, or all engines require install/authentication;
- a CLI fallback is reported as a QR scan.

Evidence: record `qrRendered`, `enrollmentTransport`, `fingerprintMatched`,
`runnerConnected`, `connectionTestPassed`, and `realEngineAuthenticated`. Store no QR,
challenge, fingerprint, Runner ID, session ID, terminal output, or provider metadata.

### 6. Run the first Mode A Delegated Work

1. Keep the Runner daemon connected and return to `에이전트` / Control Home.
2. Confirm the header says `Runner 연결됨 · Workspace 실행 준비`.
3. Select `Mode A · 목표만`. Do not open the optional role selector and do not choose
   Mode B.
4. Submit this harmless, non-external goal or an equally bounded approved variant:

   > `LIVE DOGFOOD OK` 한 줄을 포함한 짧은 상태 보고서를 만들어줘. 외부 전송,
   > 게시, 구매, 삭제, 파일 변경은 하지 마.

5. Observe the Work Conversation until it reaches a terminal result. Do not copy its raw
   prompt, output, tool log, or provider session into evidence.
6. Open Calendar and confirm the resulting Delegated Work projection is present with an
   Agent source/badge. Do not open or capture unrelated Calendar events.

Expected:

- the `위임` button is enabled without an explicit Responsible Agent override;
- a Work Conversation opens and identifies the work as Mode A/goal-only;
- a Responsible Agent becomes visible as the accountability record after assignment;
- at least one user-meaningful checkpoint and a terminal completed result appear;
- the Calendar projection for this Delegated Work is visible.

Fail signals:

- `새 작업을 위임하려면 실행 컴퓨터 연결이 필요합니다`, a disabled `위임` button,
  or a forced Mode B agent choice;
- a fake/synthetic roster is created merely to decorate the empty state;
- planning or execution blocks on Runner/provider authentication, the Runner disconnects,
  no checkpoint appears, or the work never reaches a terminal result;
- the work completes but no Calendar projection appears;
- the agent performs an external or destructive action despite the bounded goal.

Evidence: record `delegationMode=mode_a`, `explicitAgentOverride=false`,
`responsibleAgentAssigned`, `checkpointObserved`, `delegatedWorkCompleted`, and
`calendarProjectionObserved`. Do not retain work IDs, prompts, outputs, or event text.

### 7. Reopen and verify durable state

1. Quit and reopen the same approved Desktop build and isolated profile; leave the Runner
   daemon running.
2. Confirm the WorkOS session restores, the Google source remains connected, the Runner
   returns/stays connected, and the completed Work Conversation and Calendar projection remain.
3. Confirm no synthetic agents appeared during restart.

Expected:

- no second login or consent is required while the sessions remain valid;
- the completed result, source connection, and Runner readiness restore without fixture data.

Fail signals:

- the app returns to an unexplained signed-out state, loses the Workspace result, duplicates
  the source/work, shows another Workspace's data, or marks a disconnected Runner as ready.

Evidence: record the five restore observations as booleans and the reopen timestamp.

## Pass criteria and follow-up

The manual gate is `PASS` only when every required observation is true, no stop rule fired,
and `enrollmentTransport=qr_scanner` when the release specifically requires QR scanner proof.
`displayed_challenge_cli` can pass live Runner enrollment and Mode A execution, but the QR
scanner residual remains `PENDING`.

On any failure, preserve only the redacted evidence below, stop promotion, and link a defect
or follow-up plan. Do not weaken auth mode or reuse another Workspace's data to obtain a pass.
Rollback remains governed by
[`production-release-rollback.md`](production-release-rollback.md).

## Secret-free evidence template

Copy this template to an approved evidence location. Delete unused optional screenshot rows;
never paste raw command output into it.

```markdown
# Production live dogfood evidence

- Captured at (UTC):
- Environment: staging | production
- Candidate commit (full SHA):
- Gateway deployment ID:
- Desktop build ID:
- Runner version:
- Result: PASS | FAIL | BLOCKED
- Failure stage/reason (bounded, no provider response body):
- External mutation: none beyond test-account OAuth grants, Runner enrollment, and the bounded Delegated Work

## Configuration observations

- workspaceAuthModeProduction: true | false
- workosConfigPresent: true | false
- googleConfigPresent: true | false
- googleVaultPresent: true | false
- externalCalendarEnabled: true | false
- candidateBound: true | false

## Live observations

- anonymousAgents401:
- anonymousState401:
- workosProvider: workos_authkit
- workosLiveTenant:
- workosInjectedAdapter: false
- desktopCallbackReturned:
- initialReadinessCount:
- initialAgentCount: 0
- initialDelegatedWorkCount: 0
- syntheticRosterObserved: false
- googleConsentCompleted:
- googleSourceConnected:
- googleInitialSyncCompleted:
- googleLastSyncPresent:
- qrRendered:
- enrollmentTransport: qr_scanner | displayed_challenge_cli
- qrScannerGate: pass | pending | fail
- fingerprintMatched:
- runnerConnected:
- connectionTestPassed:
- realEngineAuthenticated:
- delegationMode: mode_a
- explicitAgentOverride: false
- responsibleAgentAssigned:
- checkpointObserved:
- delegatedWorkCompleted:
- calendarProjectionObserved:
- desktopSessionRestored:
- googleSourceRestored:
- runnerConnectionRestored:
- workConversationRestored:
- syntheticRosterAfterRestart: false

## Optional redacted artifacts

| File | SHA-256 | Redaction review passed | What it proves |
| --- | --- | --- | --- |
|  |  | true |  |

## Review

- No secrets or personal/calendar/work content retained: true | false
- Operator sign-off:
- Release reviewer sign-off:
- Remaining gates:
```
