# Bind every Runner to an authenticated Workspace

Agent Calendar requires an authenticated User and Workspace membership before Runner Enrollment.
The enrollment exchange binds a customer-controlled host identity to exactly one Workspace and
creates a pending Runner identity. The signed-in Workspace owner must confirm the device
fingerprint before the control plane activates it and delivers a separately revocable Runner
credential to that host; the one-time enrollment challenge is never the ongoing account or
runtime credential. A Workspace may own multiple Runners, but a Runner profile cannot execute,
search, emit events, or provide local capabilities for another Workspace.

This deliberately differs from treating a direct pairing URL as sufficient product authority.
Orca's remote-runtime model demonstrates server-owned agent processes, local provider credentials,
and revocable client grants, but Agent Calendar adds a multi-tenant control plane: User sessions
authorize clients, WorkspaceScope authorizes product data, and Runner identity authorizes only the
bound execution host. Desktop and Mobile never receive a broad Runner secret, and no unavailable
Runner is silently replaced by another customer's Runner.

Cloud-hosted functions such as calendar synchronization or an explicitly granted GPT model do not
need to execute physically on the Runner. They still operate under the same User and WorkspaceScope;
only local files, local credentials, and customer-host execution cross the Runner seam.
