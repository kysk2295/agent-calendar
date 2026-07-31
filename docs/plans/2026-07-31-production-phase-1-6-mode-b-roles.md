# Plan: Production Phase 1.6 — Mode B role delegation (MVP)

- Date: 2026-07-31
- Work size: Medium
- Status: Verified
- Branch: `kysk2295/agent-control-p0-wave1`

## Goal

Make Mode B (role-assigned Responsible Agent) a first-class Control Home path: Mode A goal-only remains default; Mode B requires choosing an agent and stamps `delegationMode` on the mission for honest UI.

## Non-Goals

- Full multi-role fan-out / @agent syntax
- Memory constellation graph
- Reassigning agent on existing work (ADR 0007 deferred)

## Verification

- Desktop presentation tests pass
- typecheck + backend:check pass
