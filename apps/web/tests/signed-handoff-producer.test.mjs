import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  produceDeploymentValues,
} from "../lib/signed-handoff.mjs";

const NOW = "2026-07-26T04:00:00.000Z";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-handoff-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const artifactPath = path.join(directory, "Agent-Calendar-1.2.3-arm64.dmg");
  const artifactBytes = Buffer.from("task-owned signed handoff fixture bytes\n");
  await fs.writeFile(artifactPath, artifactBytes);
  const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
  const candidate = {
    schemaVersion: 1,
    sourceSha: COMMIT,
    tag: "v1.2.3",
    version: "1.2.3",
    signed: true,
    notarized: true,
    stapled: true,
    desktop: {
      gatekeeperAccepted: true,
      staplerValidated: true,
      codesignDeepStrict: true,
    },
    artifactSha256: { dmg: artifactSha256 },
  };
  const candidatePath = path.join(directory, "candidate.json");
  await fs.writeFile(candidatePath, `${JSON.stringify(candidate)}\n`);
  const candidateBytes = await fs.readFile(candidatePath);
  const candidateSha256 = crypto.createHash("sha256").update(candidateBytes).digest("hex");
  const receipt = {
    schemaVersion: 1,
    kind: "local-qa",
    issuedAt: "2026-07-26T03:55:00.000Z",
    expiresAt: "2026-07-26T05:00:00.000Z",
    sourceCommit: COMMIT,
    version: "1.2.3",
    artifact: {
      fileName: "Agent-Calendar-1.2.3-arm64.dmg",
      size: artifactBytes.length,
      sha256: artifactSha256,
      downloadUrl: "http://127.0.0.1:43123/fixture-download",
    },
    candidateEvidenceSha256: candidateSha256,
    attestation: {
      type: "github-build-provenance",
      verified: true,
      artifactSha256,
      sourceCommit: COMMIT,
      workflowRef: "desktop-release.yml@refs/tags/v1.2.3",
      verifiedAt: "2026-07-26T03:56:00.000Z",
    },
    signup: { url: "http://127.0.0.1:43123/local-signup" },
    operations: {
      supportRoute: "/support",
      supportOwnerId: "team-support",
      securityOwnerId: "team-security",
      statusCommunicationOwned: true,
      accessRollbackOwned: true,
    },
    marker: "LOCAL QA FIXTURE — NOT PRODUCTION RELEASE EVIDENCE",
  };
  const baseArtifact = receipt.artifact;
  const baseAttestation = receipt.attestation;
  const baseOperations = receipt.operations;
  Object.assign(receipt, overrides.receipt);
  receipt.artifact = { ...baseArtifact, ...overrides.receipt?.artifact };
  receipt.attestation = { ...baseAttestation, ...overrides.receipt?.attestation };
  receipt.operations = { ...baseOperations, ...overrides.receipt?.operations };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const signature = crypto.sign(null, Buffer.from(canonicalJson(receipt)), privateKey);
  const receiptPath = path.join(directory, "receipt.json");
  const signaturePath = path.join(directory, "receipt.sig");
  const publicKeyPath = path.join(directory, "release-public.pem");
  const outputPath = path.join(directory, "deployment-values.json");
  await Promise.all([
    fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`),
    fs.writeFile(signaturePath, signature.toString("base64")),
    fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" })),
  ]);
  return {
    directory,
    artifactPath,
    candidatePath,
    receiptPath,
    signaturePath,
    publicKeyPath,
    outputPath,
    receipt,
  };
}

async function produce(paths, changes = {}) {
  return produceDeploymentValues({
    artifactPath: paths.artifactPath,
    candidateEvidencePath: paths.candidatePath,
    receiptPath: paths.receiptPath,
    signaturePath: paths.signaturePath,
    trustedPublicKeyPath: paths.publicKeyPath,
    outputPath: paths.outputPath,
    expectedVersion: "1.2.3",
    expectedCommit: COMMIT,
    now: NOW,
    allowLocalQa: true,
    ...changes,
  });
}

test("producer verifies actual bytes and emits only signed receipt deployment values", async (t) => {
  const paths = await fixture(t);
  const result = await produce(paths);
  const output = JSON.parse(await fs.readFile(paths.outputPath, "utf8"));

  assert.equal(result.ok, true);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.release.sourceCommit, COMMIT);
  assert.equal(output.release.version, "1.2.3");
  assert.equal(output.release.sha256, paths.receipt.artifact.sha256);
  assert.equal(output.release.localQa, true);
  assert.equal(typeof output.values.WEB_HANDOFF_RELEASE_RECEIPT, "string");
  assert.equal(typeof output.values.WEB_HANDOFF_RELEASE_SIGNATURE, "string");
  assert.equal(output.values.NEXT_PUBLIC_DESKTOP_VERIFIED, undefined);
});

test("producer rejects tampered bytes and leaves no partial deployment values", async (t) => {
  const paths = await fixture(t);
  await fs.appendFile(paths.artifactPath, "tampered");

  await assert.rejects(produce(paths), /artifact (size|SHA-256)/i);
  await assert.rejects(fs.access(paths.outputPath));
});

test("producer rejects wrong SHA, version, and full source commit bindings", async (t) => {
  for (const [name, receipt, changes, pattern] of [
    ["sha", {
      artifact: { sha256: "b".repeat(64) },
      attestation: { artifactSha256: "b".repeat(64) },
    }, {}, /SHA-256/i],
    ["version", {
      version: "1.2.4",
      attestation: { workflowRef: "desktop-release.yml@refs/tags/v1.2.4" },
    }, {}, /version/i],
    ["commit", {
      sourceCommit: "f".repeat(40),
      attestation: { sourceCommit: "f".repeat(40) },
    }, {}, /source commit/i],
    ["short-commit", { sourceCommit: "abc123" }, {}, /full source commit/i],
  ]) {
    await t.test(name, async (nested) => {
      const paths = await fixture(nested, { receipt });
      await assert.rejects(produce(paths, changes), pattern);
      await assert.rejects(fs.access(paths.outputPath));
    });
  }
});

test("producer rejects missing or stale notary, staple, and attestation evidence", async (t) => {
  for (const [name, mutate, pattern] of [
    ["notary", (candidate) => { candidate.notarized = false; }, /notarized/i],
    ["staple", (candidate) => { candidate.stapled = false; }, /stapled/i],
    ["attestation", null, /attestation/i],
    ["stale", null, /expired/i],
  ]) {
    await t.test(name, async (nested) => {
      const receipt = name === "attestation"
        ? { attestation: { verified: false } }
        : name === "stale"
          ? { expiresAt: "2026-07-26T03:59:59.000Z" }
          : {};
      const paths = await fixture(nested, { receipt });
      if (mutate) {
        const candidate = JSON.parse(await fs.readFile(paths.candidatePath, "utf8"));
        mutate(candidate);
        await fs.writeFile(paths.candidatePath, `${JSON.stringify(candidate)}\n`);
      }
      await assert.rejects(produce(paths), pattern);
      await assert.rejects(fs.access(paths.outputPath));
    });
  }
});

test("producer rejects absent support, security, status, or access rollback ownership", async (t) => {
  for (const [field, value] of [
    ["supportOwnerId", ""],
    ["securityOwnerId", ""],
    ["statusCommunicationOwned", false],
    ["accessRollbackOwned", false],
  ]) {
    await t.test(field, async (nested) => {
      const paths = await fixture(nested, {
        receipt: { operations: { [field]: value } },
      });
      await assert.rejects(produce(paths), /operational ownership/i);
      await assert.rejects(fs.access(paths.outputPath));
    });
  }
});

test("producer rejects a hand-authored receipt without the trusted release signature", async (t) => {
  const paths = await fixture(t);
  const handAuthored = JSON.parse(await fs.readFile(paths.receiptPath, "utf8"));
  handAuthored.signup.url = "http://127.0.0.1:43123/altered-signup";
  await fs.writeFile(paths.receiptPath, `${JSON.stringify(handAuthored)}\n`);

  await assert.rejects(produce(paths), /signature/i);
  await assert.rejects(fs.access(paths.outputPath));
});
