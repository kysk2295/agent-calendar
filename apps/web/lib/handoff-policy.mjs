import { validateSignedReceipt } from "./signed-handoff.mjs";

function closedHandoff() {
  return {
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
  };
}

export async function resolveHandoff(config = {}) {
  if (!config.receipt || !config.signature || !config.trustedPublicKey) return closedHandoff();
  try {
    const receipt = JSON.parse(
      Buffer.from(String(config.receipt), "base64url").toString("utf8"),
    );
    const verified = validateSignedReceipt({
      receipt,
      signature: config.signature,
      trustedPublicKey: config.trustedPublicKey,
      now: config.now,
      allowLocalQa: config.localQa === true,
    });
    return {
      signup: {
        available: true,
        href: receipt.signup.url,
        label: "Private beta 신청",
      },
      download: {
        available: true,
        href: receipt.artifact.downloadUrl,
        label: `macOS용 다운로드 · v${receipt.version}`,
        version: receipt.version,
        sha256: receipt.artifact.sha256,
      },
      marker: verified.localQa ? receipt.marker : null,
    };
  } catch {
    return closedHandoff();
  }
}
