export type DesktopSessionTruth = {
  signedIn?: boolean;
};

export function resolveDesktopSignedIn(
  hasPublicProfile: boolean,
  sessionStatus?: DesktopSessionTruth,
): boolean {
  return sessionStatus
    ? sessionStatus.signedIn === true
    : hasPublicProfile;
}
