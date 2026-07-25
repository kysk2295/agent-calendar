import assert from "node:assert/strict";
import test from "node:test";

import { resolveHandoff } from "../lib/handoff-policy.mjs";

test("keeps signup closed unless the destination is HTTPS", () => {
  assert.deepEqual(resolveHandoff({ signupUrl: "http://example.com/join" }).signup, {
    available: false,
    href: null,
    label: "Private beta 준비 중",
  });

  assert.deepEqual(resolveHandoff({ signupUrl: "https://example.com/join" }).signup, {
    available: true,
    href: "https://example.com/join",
    label: "Private beta 신청",
  });
});

test("keeps desktop download closed until every release proof is present", () => {
  const almostReady = {
    downloadUrl: "https://example.com/Agent-Calendar.dmg",
    downloadVersion: "1.0.0",
    downloadSha256: "a".repeat(64),
  };

  assert.equal(resolveHandoff(almostReady).download.available, false);
  assert.equal(
    resolveHandoff({ ...almostReady, downloadVerified: "true" }).download.available,
    true,
  );
});

test("rejects malformed versions, hashes, and non-HTTPS artifacts", () => {
  const baseline = {
    downloadUrl: "https://example.com/Agent-Calendar.dmg",
    downloadVersion: "1.0.0",
    downloadSha256: "a".repeat(64),
    downloadVerified: "true",
  };

  assert.equal(
    resolveHandoff({ ...baseline, downloadUrl: "http://example.com/app.dmg" })
      .download.available,
    false,
  );
  assert.equal(
    resolveHandoff({ ...baseline, downloadVersion: "latest" }).download.available,
    false,
  );
  assert.equal(
    resolveHandoff({ ...baseline, downloadSha256: "not-a-hash" }).download.available,
    false,
  );
});
