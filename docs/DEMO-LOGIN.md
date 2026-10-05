# Demo Login

Google access is managed in Firestore, not an email list in application code.
Admins use Users/Permissions to approve an email and its explicit first-login
role. `config/allowedEmails` contains `emails` and `initialRoles`; it is not
client-readable or writable. Current roles live in
`organizations/consubanco/members/{uid}` and are not reset by later sign-ins.
New approvals provision an unverified, passwordless Auth identity because client
signup remains disabled. Only a real verified Google sign-in can activate its
membership. Pending edits use a configuration version to reject stale updates.
Revocation removes email approval and disables membership atomically.

The demo runtime requires only `firebaseauth.users.get` and
`firebaseauth.users.create` for account lookup and admin invitations, scoped to
the demo project. No Auth update/delete privilege is needed.

An operator can migrate existing initial roles and approve one supervisor with
`node scripts/configure-demo-access.mjs <email> --apply`; omit `--apply` for a
read-only preview. This never changes an existing target role or revocation.

A reserved identity signs in with username `demo-supervisor`. Firebase stores its password
credentials; the internal reserved email is `demo-supervisor@kesp-demo.invalid`
and UID is `kesp-demo-supervisor`. This is not a verified real mailbox.

The password identity is permanently supervisor-only in backend authorization,
Firestore rules and Storage rules. It cannot manage users/permissions or access
automation. Its active membership and allowlist entry remain required. Disabling
the membership revokes data access; disable the Auth account and revoke sessions
as well when retiring the shared demo login. Never put its password in Git.

After deploying the exact reviewed commit, an authorized demo operator can run:

```sh
node scripts/provision-demo-supervisor.mjs /restricted/outside-repo/demo-supervisor-credentials.json --create-demo-supervisor
```

This refuses existing identities or memberships, preserves the Google providers,
disables client signup, enables password sign-in and creates a random credential
file with mode 0600 outside the repository. Account creation starts disabled;
activation follows membership and provider verification. On partial failure,
inspect the demo Auth/member/provider state before proceeding. Do not delete or
overwrite the credentials file or silently rotate an existing account.

The private runtime archive and redacted public repository have independent
histories. Audio, restricted reconstruction material, access-directory snapshots
and live credentials are not repository data.
