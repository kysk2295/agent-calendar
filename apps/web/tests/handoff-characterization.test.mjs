import assert from "node:assert/strict";
import test from "node:test";

import { resolveHandoff } from "../lib/handoff-policy.mjs";

test("legacy handoff input characterized by PIN now fails closed", async () => {
  const actual = await resolveHandoff({
    signupUrl: "https://example.com/private-beta",
    downloadUrl: "https://example.com/Agent-Calendar-1.2.3-arm64.dmg",
    downloadVersion: "1.2.3",
    downloadSha256: "a".repeat(64),
    downloadVerified: "true",
  });

  assert.deepEqual(actual, {
    signup: {
      available: false,
      href: null,
      label: "Private beta 준비 중",
    },
    download: {
      available: false,
      href: null,
      label: "Desktop 다운로드 준비 중",
      version: null,
      sha256: null,
    },
    marker: null,
  });
});
