import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OWNER_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_RECEIPT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// The matching private key is intentionally not present in the repository. A real
// release signer rotation must replace this reviewed trust root in product code.
export const PRODUCTION_HANDOFF_TRUSTED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjjw9n6wM1MLXJ0ZU7pi6oNU/EePOM9dOE5y7ue/Tmas=
-----END PUBLIC KEY-----
`;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parseInstant(value, label) {
  const timestamp = Date.parse(value);
  required(Number.isFinite(timestamp), `${label} must be an ISO-8601 instant.`);
  return timestamp;
}

function parseJsonBytes(bytes, label) {
  required(bytes.length > 0 && bytes.length <= MAX_JSON_BYTES, `${label} is missing or oversized.`);
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    required(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is malformed JSON.`);
    throw error;
  }
}

function isHttps(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopbackHttp(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export function validateSignedReceipt({
  receipt,
  signature,
  trustedPublicKey,
  now = new Date().toISOString(),
  allowLocalQa = false,
}) {
  required(receipt?.schemaVersion === 1, "Unsupported signed handoff receipt schema.");
  required(receipt.kind === "production" || receipt.kind === "local-qa", "Invalid handoff receipt kind.");
  const localQa = receipt.kind === "local-qa";
  required(!localQa || allowLocalQa, "Local QA handoff receipts are disabled.");
  required(
    !localQa || receipt.marker === "LOCAL QA FIXTURE — NOT PRODUCTION RELEASE EVIDENCE",
    "Local QA receipt requires the explicit non-production marker.",
  );
  required(STABLE_VERSION.test(receipt.version), "Receipt version must be stable semantic version.");
  required(FULL_COMMIT.test(receipt.sourceCommit), "Receipt requires a full source commit.");
  required(SHA256.test(receipt.artifact?.sha256), "Receipt artifact SHA-256 is invalid.");
  required(
    Number.isSafeInteger(receipt.artifact?.size) && receipt.artifact.size > 0,
    "Receipt artifact size is invalid.",
  );
  required(
    receipt.artifact?.fileName === path.basename(receipt.artifact?.fileName || ""),
    "Receipt artifact file name is invalid.",
  );
  required(SHA256.test(receipt.candidateEvidenceSha256), "Candidate evidence SHA-256 is invalid.");
  required(
    localQa
      ? isLoopbackHttp(receipt.artifact?.downloadUrl) && isLoopbackHttp(receipt.signup?.url)
      : isHttps(receipt.artifact?.downloadUrl) && isHttps(receipt.signup?.url),
    "Receipt destinations do not match the allowed deployment mode.",
  );

  const issuedAt = parseInstant(receipt.issuedAt, "Receipt issuedAt");
  const expiresAt = parseInstant(receipt.expiresAt, "Receipt expiresAt");
  const nowAt = parseInstant(now, "Verification time");
  required(expiresAt > issuedAt, "Receipt expiration must follow issue time.");
  required(expiresAt - issuedAt <= MAX_RECEIPT_LIFETIME_MS, "Receipt lifetime exceeds seven days.");
  required(issuedAt <= nowAt + MAX_CLOCK_SKEW_MS, "Receipt was issued in the future.");
  required(expiresAt > nowAt, "Signed handoff receipt is expired.");

  const attestation = receipt.attestation;
  required(
    attestation?.type === "github-build-provenance"
      && attestation.verified === true
      && attestation.artifactSha256 === receipt.artifact.sha256
      && attestation.sourceCommit === receipt.sourceCommit
      && typeof attestation.workflowRef === "string"
      && attestation.workflowRef.includes(`refs/tags/v${receipt.version}`),
    "Fresh artifact attestation binding is required.",
  );
  const attestationAt = parseInstant(attestation.verifiedAt, "Attestation verifiedAt");
  required(
    attestationAt >= issuedAt - MAX_CLOCK_SKEW_MS && attestationAt <= nowAt + MAX_CLOCK_SKEW_MS,
    "Attestation verification is stale or future-dated.",
  );

  const operations = receipt.operations;
  required(
    operations?.supportRoute === "/support"
      && OWNER_ID.test(operations.supportOwnerId || "")
      && OWNER_ID.test(operations.securityOwnerId || "")
      && operations.statusCommunicationOwned === true
      && operations.accessRollbackOwned === true,
    "Complete operational ownership is required.",
  );

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalJson(receipt)),
      trustedPublicKey,
      Buffer.from(String(signature || "").trim(), "base64"),
    );
  } catch {
    verified = false;
  }
  required(verified, "Receipt signature is not valid for the trusted release key.");
  return { receipt, localQa };
}

async function readBounded(filePath, label) {
  const stat = await fs.stat(filePath);
  required(stat.isFile() && stat.size > 0 && stat.size <= MAX_JSON_BYTES, `${label} is missing or oversized.`);
  return fs.readFile(filePath);
}

export async function produceDeploymentValues({
  artifactPath,
  candidateEvidencePath,
  receiptPath,
  signaturePath,
  trustedPublicKeyPath,
  outputPath,
  expectedVersion,
  expectedCommit,
  now = new Date().toISOString(),
  allowLocalQa = false,
}) {
  required(STABLE_VERSION.test(expectedVersion || ""), "Expected version must be stable semantic version.");
  required(FULL_COMMIT.test(expectedCommit || ""), "Expected commit must be a full source commit.");
  const [artifactStat, artifactBytes, candidateBytes, receiptBytes, signatureBytes, trustedPublicKey] =
    await Promise.all([
      fs.stat(artifactPath),
      fs.readFile(artifactPath),
      readBounded(candidateEvidencePath, "Candidate evidence"),
      readBounded(receiptPath, "Signed handoff receipt"),
      readBounded(signaturePath, "Receipt signature"),
      readBounded(trustedPublicKeyPath, "Trusted release public key"),
    ]);
  required(artifactStat.isFile() && artifactStat.size > 0, "Desktop artifact is missing.");

  const candidate = parseJsonBytes(candidateBytes, "Candidate evidence");
  const receipt = parseJsonBytes(receiptBytes, "Signed handoff receipt");
  validateSignedReceipt({
    receipt,
    signature: signatureBytes.toString("utf8"),
    trustedPublicKey,
    now,
    allowLocalQa,
  });

  required(receipt.version === expectedVersion, "Receipt version does not match the expected version.");
  required(receipt.sourceCommit === expectedCommit, "Receipt source commit does not match.");
  required(candidate.schemaVersion === 1, "Unsupported candidate evidence schema.");
  required(candidate.version === expectedVersion && candidate.tag === `v${expectedVersion}`, "Candidate version does not match.");
  required(candidate.sourceSha === expectedCommit, "Candidate source commit does not match.");
  required(candidate.signed === true, "Candidate must be signed.");
  required(candidate.notarized === true, "Candidate must be notarized.");
  required(candidate.stapled === true, "Candidate must be stapled.");
  required(
    candidate.desktop?.codesignDeepStrict === true
      && candidate.desktop.gatekeeperAccepted === true
      && candidate.desktop.staplerValidated === true,
    "Candidate Desktop signature, Gatekeeper, and staple checks are required.",
  );
  required(
    receipt.candidateEvidenceSha256 === sha256(candidateBytes),
    "Candidate evidence digest does not match the signed receipt.",
  );
  required(
    candidate.artifactSha256?.dmg === receipt.artifact.sha256,
    "Candidate and receipt artifact SHA-256 do not match.",
  );
  required(artifactStat.size === receipt.artifact.size, "Desktop artifact size does not match receipt.");
  required(sha256(artifactBytes) === receipt.artifact.sha256, "Desktop artifact SHA-256 does not match receipt.");

  const output = {
    schemaVersion: 1,
    release: {
      sourceCommit: receipt.sourceCommit,
      version: receipt.version,
      sha256: receipt.artifact.sha256,
      size: receipt.artifact.size,
      localQa: receipt.kind === "local-qa",
    },
    values: {
      WEB_HANDOFF_RELEASE_RECEIPT: Buffer.from(canonicalJson(receipt)).toString("base64url"),
      WEB_HANDOFF_RELEASE_SIGNATURE: signatureBytes.toString("utf8").trim(),
    },
  };
  const temporaryPath = `${outputPath}.partial-${process.pid}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(output, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporaryPath, outputPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
  return { ok: true, outputPath, release: output.release };
}
