const stableVersion = /^\d+\.\d+\.\d+$/;
const sha256 = /^[a-f0-9]{64}$/;

function httpsUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function resolveHandoff(config = {}) {
  const signupUrl = httpsUrl(config.signupUrl);
  const downloadUrl = httpsUrl(config.downloadUrl);
  const version = config.downloadVersion?.trim() ?? "";
  const hash = config.downloadSha256?.trim() ?? "";
  const verified = config.downloadVerified === "true";
  const downloadAvailable = Boolean(
    downloadUrl &&
      stableVersion.test(version) &&
      sha256.test(hash) &&
      verified,
  );

  return {
    signup: signupUrl
      ? {
          available: true,
          href: signupUrl,
          label: "Private beta 신청",
        }
      : {
          available: false,
          href: null,
          label: "Private beta 준비 중",
        },
    download: downloadAvailable
      ? {
          available: true,
          href: downloadUrl,
          label: `macOS용 다운로드 · v${version}`,
          version,
          sha256: hash,
        }
      : {
          available: false,
          href: null,
          label: "Desktop 다운로드 준비 중",
          version: null,
          sha256: null,
        },
  };
}
