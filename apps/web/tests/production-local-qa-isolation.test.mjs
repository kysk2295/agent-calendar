import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  PRODUCTION_HANDOFF_TRUSTED_PUBLIC_KEY,
} from "../lib/signed-handoff.mjs";

test("built production worker rejects spoofed local-QA argv and former env trust inputs", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const now = new Date();
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const artifactSha256 = "a".repeat(64);
  const receipt = {
    schemaVersion: 1,
    kind: "local-qa",
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    sourceCommit: commit,
    version: "1.2.3",
    artifact: {
      fileName: "Agent-Calendar-1.2.3-arm64.dmg",
      size: 42,
      sha256: artifactSha256,
      downloadUrl: "http://127.0.0.1:43123/fixture-download",
    },
    candidateEvidenceSha256: "b".repeat(64),
    attestation: {
      type: "github-build-provenance",
      verified: true,
      artifactSha256,
      sourceCommit: commit,
      workflowRef: "desktop-release.yml@refs/tags/v1.2.3",
      verifiedAt: now.toISOString(),
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
  const originalArgv = [...process.argv];
  const originalEnvironment = {
    receipt: process.env.WEB_HANDOFF_RELEASE_RECEIPT,
    signature: process.env.WEB_HANDOFF_RELEASE_SIGNATURE,
    trustedPublicKey: process.env.WEB_HANDOFF_TRUSTED_PUBLIC_KEY,
    localQa: process.env.WEB_HANDOFF_LOCAL_QA,
  };
  process.argv.push("/unrelated/local-signed-handoff-qa.mjs");
  process.env.WEB_HANDOFF_RELEASE_RECEIPT =
    Buffer.from(canonicalJson(receipt)).toString("base64url");
  process.env.WEB_HANDOFF_RELEASE_SIGNATURE =
    crypto.sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString("base64");
  process.env.WEB_HANDOFF_TRUSTED_PUBLIC_KEY =
    publicKey.export({ type: "spki", format: "pem" });
  process.env.WEB_HANDOFF_LOCAL_QA = "1";

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("spoof-regression", `${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const response = await worker.fetch(
      new Request("http://localhost/"),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      { waitUntil() {}, passThroughOnException() {} },
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Private beta 준비 중/);
    assert.match(html, /Desktop 다운로드 준비 중/);
    assert.doesNotMatch(html, /LOCAL QA FIXTURE/);
    assert.doesNotMatch(html, /href="http:\/\/127\.0\.0\.1:43123/);
    assert.match(PRODUCTION_HANDOFF_TRUSTED_PUBLIC_KEY, /BEGIN PUBLIC KEY/);

    const serverRoot = new URL("../dist/server/", import.meta.url);
    const javascriptFiles = (await fs.readdir(serverRoot, { recursive: true }))
      .filter((entry) => entry.endsWith(".js"));
    const productionBundle = (
      await Promise.all(
        javascriptFiles.map((entry) => fs.readFile(new URL(entry, serverRoot), "utf8")),
      )
    ).join("\n");
    for (const forbidden of [
      "WEB_HANDOFF_LOCAL_QA",
      "WEB_HANDOFF_TRUSTED_PUBLIC_KEY",
      "local-signed-handoff-qa.mjs",
      "BEGIN PRIVATE KEY",
    ]) {
      assert.equal(productionBundle.includes(forbidden), false, `bundle contains ${forbidden}`);
    }
  } finally {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    for (const [name, value] of Object.entries({
      WEB_HANDOFF_RELEASE_RECEIPT: originalEnvironment.receipt,
      WEB_HANDOFF_RELEASE_SIGNATURE: originalEnvironment.signature,
      WEB_HANDOFF_TRUSTED_PUBLIC_KEY: originalEnvironment.trustedPublicKey,
      WEB_HANDOFF_LOCAL_QA: originalEnvironment.localQa,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
