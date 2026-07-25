# Two-account Runner isolation ETE evidence

- Date: 2026-07-25
- Result: Pass
- Surface: production-mode Electron + injected AuthKit adapter + ephemeral PostgreSQL +
  two real Runner processes + deterministic Fake Engine

## Command

`AGENT_CALENDAR_E2E_TWO_ACCOUNT=1 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

## Observed product journey

1. Account A completed AuthKit login and received its own newly bootstrapped Workspace.
2. Account A issued a one-use Runner challenge in Desktop, confirmed the presented device
   fingerprint, connected Runner A, and completed one Delegated Work.
3. Account A saw exactly one successful Agent result in its Calendar.
4. A separate clean Desktop profile completed AuthKit login as Account B and received a different
   Workspace.
5. Account B's Agent Control Space contained no Account A work, activity, or Runner fingerprint.
6. Account B issued its own challenge, confirmed and connected Runner B, completed its own
   Delegated Work, and saw only its own Calendar result.
7. Runner A reconnected and Account A's Desktop profile restarted without another login.
8. Account A rehydrated only Account A work and resolved Engine evidence; Account B's work and
   Runner fingerprint remained absent.
9. A final `work-once` for each Runner returned idle, proving neither Runner could lease the
   other Workspace's completed or queued work.

## Authoritative counts

| Evidence | Account A Workspace | Account B Workspace |
| --- | ---: | ---: |
| Active Runner | 1 | 1 |
| Completed durable job | 1 | 1 |
| Agent-work Calendar result | 1 | 1 |

- AuthKit completion count: 2
- Distinct WorkOS subjects: 2
- Distinct Workspace IDs: 2
- Cross-Workspace Calendar title matches: 0
- Account A secure-session restore login replays: 0

The ETE obtains Workspace IDs from the verified WorkOS identity and active membership rows only
after completing the UI journey. SQL is used as terminal ownership evidence, never to create
users, sessions, Runners, work, or Calendar results.

## Manual surface evidence

- Account A completed Work Conversation:
  `apps/desktop/test-results/phase3-two-account-isolation-ete/01-workspace-a-completed.png`
- Account A Calendar:
  `apps/desktop/test-results/phase3-two-account-isolation-ete/02-workspace-a-calendar.png`
- Account B clean Agent Control Space after its own Runner enrollment:
  `apps/desktop/test-results/phase3-two-account-isolation-ete/03-workspace-b-clean.png`
- Account B Calendar:
  `apps/desktop/test-results/phase3-two-account-isolation-ete/04-workspace-b-calendar.png`
- Account A rehydrated Work Conversation after Account B completed:
  `apps/desktop/test-results/phase3-two-account-isolation-ete/05-workspace-a-rehydrated.png`

All five required screenshots have distinct SHA-256 hashes. Manual inspection confirmed the
account name, empty/owned Work surfaces, and rehydrated result match the asserted Workspace.

## Scope boundary

This proves the product's account-derived Workspace isolation using the same production auth,
Runner, durable execution, Calendar, Electron secure-session, and React surfaces. It does not
claim that the external WorkOS tenant redirect URI/domain configuration is deployed; live tenant
configuration remains a release gate.

The signed/notarized macOS Desktop release workflow now runs
`npm run verify:multi-user-ete` before packaging. A release candidate cannot proceed from
contract verification to signing unless this two-account product journey passes.
