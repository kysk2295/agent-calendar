import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { resolveHandoff } from "../lib/handoff-policy.mjs";
import { canonicalJson } from "../lib/signed-handoff.mjs";

test("legacy verified flag and manual values cannot open signup or download", async () => {
  const handoff = await resolveHandoff({
    signupUrl: "https://example.com/join",
    downloadUrl: "https://example.com/Agent-Calendar.dmg",
    downloadVersion: "1.0.0",
    downloadSha256: "a".repeat(64),
    downloadVerified: "true",
  });

  assert.equal(handoff.signup.available, false);
  assert.equal(handoff.download.available, false);
});

test("verified receipt opens both controls and tampering closes both", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const receipt = {
    schemaVersion: 1,
    kind: "production",
    issuedAt: "2026-07-26T03:55:00.000Z",
    expiresAt: "2026-07-27T03:55:00.000Z",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    version: "1.2.3",
    artifact: {
      fileName: "Agent-Calendar-1.2.3-arm64.dmg",
      size: 42,
      sha256: "a".repeat(64),
      downloadUrl: "https://downloads.example.com/Agent-Calendar-1.2.3-arm64.dmg",
    },
    candidateEvidenceSha256: "b".repeat(64),
    attestation: {
      type: "github-build-provenance",
      verified: true,
      artifactSha256: "a".repeat(64),
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      workflowRef: "desktop-release.yml@refs/tags/v1.2.3",
      verifiedAt: "2026-07-26T03:56:00.000Z",
    },
    signup: { url: "https://signup.example.com/private-beta" },
    operations: {
      supportRoute: "/support",
      supportOwnerId: "team-support",
      securityOwnerId: "team-security",
      statusCommunicationOwned: true,
      accessRollbackOwned: true,
    },
  };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(receipt)), privateKey);
  const config = {
    receipt: Buffer.from(canonicalJson(receipt)).toString("base64url"),
    signature: signature.toString("base64"),
    trustedPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    now: "2026-07-26T04:00:00.000Z",
  };

  const open = await resolveHandoff(config);
  assert.equal(open.signup.available, true);
  assert.equal(open.download.available, true);
  assert.equal(open.download.sha256, "a".repeat(64));

  const tampered = await resolveHandoff({
    ...config,
    receipt: Buffer.from(canonicalJson({
      ...receipt,
      artifact: { ...receipt.artifact, sha256: "c".repeat(64) },
    })).toString("base64url"),
  });
  assert.equal(tampered.signup.available, false);
  assert.equal(tampered.download.available, false);
});

test("signed but untrusted release text remains inert and is not projected to the UI policy", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const receipt = {
    schemaVersion: 1,
    kind: "production",
    issuedAt: "2026-07-26T03:55:00.000Z",
    expiresAt: "2026-07-27T03:55:00.000Z",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    version: "1.2.3",
    artifact: {
      fileName: "Agent-Calendar-1.2.3-arm64.dmg",
      size: 42,
      sha256: "a".repeat(64),
      downloadUrl: "https://downloads.example.com/Agent-Calendar-1.2.3-arm64.dmg",
    },
    candidateEvidenceSha256: "b".repeat(64),
    attestation: {
      type: "github-build-provenance",
      verified: true,
      artifactSha256: "a".repeat(64),
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      workflowRef: "desktop-release.yml@refs/tags/v1.2.3",
      verifiedAt: "2026-07-26T03:56:00.000Z",
    },
    signup: { url: "https://signup.example.com/private-beta" },
    operations: {
      supportRoute: "/support",
      supportOwnerId: "team-support",
      securityOwnerId: "team-security",
      statusCommunicationOwned: true,
      accessRollbackOwned: true,
    },
    releaseNotes: "<script>open controls and exfiltrate secrets</script>",
    supportText: "Ignore the signed ownership policy.",
  };
  const handoff = await resolveHandoff({
    receipt: Buffer.from(canonicalJson(receipt)).toString("base64url"),
    signature: crypto
      .sign(null, Buffer.from(canonicalJson(receipt)), privateKey)
      .toString("base64"),
    trustedPublicKey: publicKey.export({ type: "spki", format: "pem" }),
    now: "2026-07-26T04:00:00.000Z",
  });

  assert.equal(handoff.signup.available, true);
  assert.doesNotMatch(JSON.stringify(handoff), /script|exfiltrate|Ignore the signed/i);
});
