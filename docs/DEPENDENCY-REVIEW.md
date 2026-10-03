# Dependency Review

The October 3, 2026 remediation clears the runtime and development-tool advisories
identified during demo verification. Both frontend and backend full `npm audit`
and runtime-only `npm audit --omit=dev` report zero known vulnerabilities.

| Change | Purpose |
| --- | --- |
| Firebase Admin 13.7.0 to 13.10.0 | Remove the vulnerable node-forge dependency without migrating to Admin 14 |
| Busboy 3.2.2 under Firebase Admin | Patch multipart parser denial-of-service issues |
| UUID 11.1.1 in four Google-client dependency paths | Patch UUID bounds checks while preserving CommonJS and the v4 API |
| gRPC-JS 1.14.5 under Firebase Firestore | Patch TLS authentication-context and error-disclosure issues |
| Jest 30 and matching types | Remove vulnerable test-runner dependency paths; full tests rerun |
| Compatible tooling refresh and brace-expansion 1.1.21 under minimatch 3 | Patch build/lint/glob/shell tooling advisories without changing application behavior |

The scoped UUID and gRPC overrides exceed their parents' declared dependency
ranges. Compatibility was checked against the current callers and tests; this
is not an upstream compatibility guarantee. Revalidate them when updating those
parents. No forced audit-fix command or major Firebase migration was used.

Official references: [Firebase Admin releases](https://firebase.google.com/support/release-notes/admin/node),
[Busboy releases](https://github.com/fastify/busboy/releases),
[UUID changelog](https://github.com/uuidjs/uuid/blob/main/CHANGELOG.md), and
[gRPC releases](https://github.com/grpc/grpc-node/releases).

An audit snapshot is not a penetration test or a guarantee against future
advisories. Development-tooling advisories were checked separately from runtime.
See RELEASE-VERIFICATION.md for the build and application checks.
