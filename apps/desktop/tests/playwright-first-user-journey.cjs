'use strict';

/**
 * First-user journey dogfood:
 * AuthKit login (Google/email hosted UI contract) → onboarding (Google Calendar,
 * Runner, Wiki, Calendar AI) → Agent Control Home Mode A/B.
 *
 * Uses injected AuthKit backend. Live WorkOS tenant remains an external gate.
 */
process.env.AGENT_CALENDAR_FIRST_USER_JOURNEY = '1';
require('./playwright-workos-authkit-login-e2e.cjs');
