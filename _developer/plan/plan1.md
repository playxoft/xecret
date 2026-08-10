# SecretManagement — Open-Source Secret Management Platform

## Master Implementation Prompt for Claude Code

You are the lead architect, security engineer, product designer, and senior full-stack engineer responsible for designing and implementing a production-grade open-source secret management platform.

The product is inspired by the simplicity and developer experience of products such as **Doppler** and **Phase**, while taking architectural inspiration from modern developer infrastructure platforms.

The product is called **SecretManagement** for now.

It is **powered by Playxoft**.

The goal is to build a simple, trustworthy, developer-first secret management platform that can eventually compete with established secret-management products.

Do not blindly implement this specification.

You are expected to:

1. Research current best practices.
2. Research current Cloudflare Workers limitations and capabilities.
3. Research current Neon PostgreSQL capabilities.
4. Research Firebase Authentication capabilities.
5. Research modern secret-management architectures.
6. Research secure CLI authentication patterns.
7. Research current open-source secret-management projects.
8. Compare implementation choices before committing to important architectural decisions.
9. Prefer simple architecture over unnecessary complexity.
10. Explain important architectural decisions before implementing them.
11. Ask for my approval when an architectural decision has significant long-term consequences.
12. Do not introduce unnecessary infrastructure such as Redis unless there is a compelling, demonstrated reason.

The final product should be:

* Extremely simple to understand.
* Extremely fast.
* Developer friendly.
* Secure by default.
* Reliable.
* Auditable.
* Open source.
* Cloudflare Workers compatible.
* Suitable for individual developers.
* Suitable for teams.
* Capable of eventually supporting enterprise workloads.
* Excellent through both the web dashboard and CLI.

---

# 1. PRODUCT VISION

Build a modern secret management platform where developers can:

* Create projects.
* Create environments.
* Add secrets.
* Update secrets.
* Delete secrets.
* Rotate secrets.
* View secret metadata.
* Manage teams.
* Manage team members.
* Assign roles.
* Assign seats.
* Assign projects.
* Assign environments.
* Control permissions at a granular level.
* Audit security-sensitive actions.
* Authenticate through Google.
* Authenticate through email/password.
* Reset forgotten passwords.
* Authenticate through the CLI.
* Pull secrets through the CLI.
* Inject secrets into applications.
* Run applications with injected secrets.
* Manage secrets across development, staging and production.
* Use the system from Next.js.
* Use the system from React applications.
* Use the system from Node.js applications.
* Use the system from Go applications.
* Eventually integrate with CI/CD systems.

The primary user experience should be:

> Create project → create environment → add secrets → install CLI → login → run/pull secrets → application receives environment variables.

Avoid unnecessary complexity.

---

# 2. PRODUCT PRIORITIES

The product must optimize for all four of these simultaneously:

## 2.1 Developer-first

The CLI and secret injection workflow must be excellent.

A developer should be able to go from zero to:

```bash
secretmanagement login
secretmanagement project select
secretmanagement env select
secretmanagement run -- npm run dev
```

with minimal friction.

---

## 2.2 Team-first

Teams must have:

* Members
* Roles
* Seats
* Projects
* Environments
* Permissions
* Invitations
* Audit logs
* Access control

The permission system must be granular enough that an administrator can control exactly what a member can access.

---

## 2.3 Security-first / Enterprise-ready

The architecture must be designed around:

* Least privilege
* Defense in depth
* Encryption
* Strong authentication
* Short-lived credentials
* Key rotation
* Auditability
* Secure session management
* Scoped access tokens
* Revocation
* Rate limiting
* Secure defaults
* Secure secret retrieval
* No plaintext secrets in logs
* No accidental secret exposure

Do not sacrifice security for convenience.

---

## 2.4 Simple UX

Despite the security and permission complexity underneath, the UI must remain extremely simple.

A normal developer should not need to understand the underlying cryptography.

The dashboard should feel closer to:

> "Here are my projects. Here are my environments. Here are my secrets."

rather than an enterprise security administration panel.

Advanced controls should exist, but remain hidden behind appropriate settings/advanced sections.

---

# 3. DEPLOYMENT REQUIREMENTS

The primary deployment environment is:

## Frontend / API

Cloudflare Workers.

The application must be designed specifically around Cloudflare Workers constraints.

The user has specified:

* Approximately 3 MB application limit.
* Approximately 10 ms CPU budget.

However, **do not blindly assume these limits are currently accurate**.

Research the current Cloudflare Workers limits and identify:

* Script size limits.
* CPU limits.
* Request limits.
* Subrequest limits.
* Runtime limitations.
* Node.js compatibility.
* Web Crypto support.
* Environment variables/secrets.
* Durable Objects.
* Queues.
* Workers KV.
* Hyperdrive.
* Other relevant Cloudflare primitives.

Then design the architecture around the actual current limits.

Avoid unnecessary dependencies.

Avoid Node-only libraries in the Worker runtime.

Prefer Web APIs and Cloudflare-compatible libraries.

---

# 4. DATABASE

Primary database:

## Neon PostgreSQL

Do not use Redis by default.

Redis is explicitly NOT part of the initial architecture.

Use PostgreSQL for:

* Users
* Organizations
* Teams
* Memberships
* Projects
* Environments
* Secrets metadata
* Encrypted secret values
* Roles
* Permissions
* Invitations
* API/CLI credentials
* Audit logs
* Sessions if required
* Configuration
* Billing/seat metadata if eventually required

Research the best Neon-compatible PostgreSQL access approach for Cloudflare Workers.

Prefer a serverless-compatible database driver.

Use:

* Proper indexes
* Foreign keys
* Constraints
* Transactions where appropriate
* UUIDs or an appropriate secure identifier strategy
* Timestamps
* Soft deletion where appropriate
* Database-level integrity

Do not create an ORM merely because ORMs are popular.

Compare:

* Drizzle
* Kysely
* Neon serverless driver
* Other appropriate options

Then select the simplest robust option.

---

# 5. AUTHENTICATION

Use:

## Firebase Authentication

Required authentication methods:

### Google

One-click Google sign-in.

### Email/password

Support:

* Sign up
* Login
* Logout
* Forgot password
* Password reset
* Email verification if appropriate
* Account management

Research the current recommended Firebase Authentication integration pattern for a Next.js App Router + Cloudflare Workers architecture.

Do NOT put Firebase Admin SDK code into places where it is incompatible with Cloudflare Workers.

If Firebase token verification is required on Workers, research the best compatible approach.

Never trust client-provided identity information.

The server must verify authentication credentials.

---

# 6. AUTHORIZATION

Do not build a simplistic:

```text
admin
user
```

permission system.

Design a proper authorization model.

At minimum support:

## Organization

An organization/workspace owns:

* Members
* Projects
* Environments
* Roles
* Permissions

## Roles

Initial suggested roles:

* Owner
* Admin
* Developer
* Viewer
* Custom Role

But research whether this is the best model.

---

# 7. GRANULAR ACCESS CONTROL

The administrator must be able to control:

### Member → Projects

Example:

```text
Alice
  Project A: allowed
  Project B: denied
  Project C: allowed
```

### Member → Environment

Example:

```text
Alice
  Project A
    Development: read/write
    Staging: read
    Production: denied
```

### Member → Actions

Permissions could include:

```text
project.read
project.create
project.update
project.delete

environment.read
environment.create
environment.update
environment.delete

secret.read
secret.create
secret.update
secret.delete
secret.rotate

member.read
member.invite
member.update
member.remove

role.read
role.create
role.update
role.delete

audit.read

cli.login
cli.token.create
cli.token.revoke
```

Research the best RBAC/ABAC hybrid model.

Avoid creating an unnecessarily complicated authorization system.

The final model should be easy to reason about.

---

# 8. SEAT MANAGEMENT

Organizations should have seats.

Administrators should be able to:

* View available seats.
* Assign seats.
* Remove seats.
* Invite members.
* Revoke membership.
* See seat usage.

Keep billing separate from the initial architecture unless required.

Do not implement payment processing in the first version.

Build the data model so billing can be added later.

---

# 9. PROJECTS

Users can create multiple projects.

Example:

```text
My Company
├── Website
├── Mobile App
├── Backend API
├── Game Backend
└── Internal Tools
```

Each project contains environments.

---

# 10. ENVIRONMENTS

Support arbitrary environments.

Default suggestions:

```text
Development
Staging
Production
```

But users should be able to create:

```text
Preview
QA
Testing
UAT
Production
```

or anything else.

Environment identifiers should be machine-friendly.

Example:

```text
development
staging
production
```

---

# 11. SECRETS

Secrets must never be stored as plaintext in the database.

Design a robust encryption architecture.

Research and implement an appropriate application-layer encryption design.

Prefer an architecture based on envelope encryption where appropriate.

For example:

```text
Master / Key Encryption Key
        ↓
Encrypted project/environment key
        ↓
Encrypted secret value
```

But do NOT blindly implement this exact model.

Research:

* Envelope encryption
* AEAD
* AES-GCM
* XChaCha20-Poly1305 if compatible
* Web Crypto
* Key rotation
* Nonce/IV handling
* Authentication tags
* Key versioning

Select the best architecture compatible with Cloudflare Workers.

Every encrypted secret should have appropriate:

* Ciphertext
* Nonce/IV
* Key version
* Algorithm/version metadata

Never invent cryptography.

Never implement custom cryptographic algorithms.

Use well-reviewed primitives.

---

# 12. MASTER KEY MANAGEMENT

The application must not hard-code encryption keys.

Never commit encryption keys to Git.

Never store root encryption secrets inside PostgreSQL in plaintext.

Research the best Cloudflare-compatible approach for protecting the root key.

Potential approaches may include:

* Cloudflare Worker Secrets
* External KMS
* Cloudflare-compatible key-management systems
* Key hierarchy

Compare the approaches.

For the initial open-source/self-hostable version, provide a practical secure default.

Document the threat model.

---

# 13. SECRET ACCESS MODEL

A secret should only be decrypted when necessary.

Do not decrypt all secrets when loading a dashboard.

For example:

```text
Dashboard
    ↓
Secret metadata
    ↓
Secret value remains protected
```

CLI retrieval:

```text
CLI
 ↓
Authentication
 ↓
Authorization
 ↓
Secret retrieval
 ↓
Decrypt
 ↓
Return only authorized secrets
```

Never log decrypted secret values.

Never include secrets in:

* Audit logs
* Error messages
* Analytics
* Request logs
* Traces
* Database query logs
* Client-side telemetry

---

# 14. CLI

Build a first-class CLI.

Do not make the CLI an afterthought.

The CLI should support something similar to:

```bash
secretmanagement login
secretmanagement logout

secretmanagement projects
secretmanagement project create
secretmanagement project select

secretmanagement environments
secretmanagement environment select

secretmanagement secrets
secretmanagement secrets get
secretmanagement secrets set
secretmanagement secrets delete

secretmanagement pull
secretmanagement run
secretmanagement exec
```

Research established secret-management CLI UX.

The CLI should be:

* Fast
* Cross-platform
* Secure
* Easy to install
* Easy to understand
* Good error messages
* Scriptable
* CI-friendly
* Suitable for local development

---

# 15. CLI LANGUAGE

I do NOT want to dictate the CLI implementation language.

Research and compare suitable choices.

At minimum consider:

* Go
* Rust
* TypeScript/Node.js

Evaluate:

* Cross-platform support
* Binary distribution
* Startup time
* Security
* Ecosystem
* Developer experience
* Package size
* Authentication
* HTTP client
* Environment injection
* Windows/macOS/Linux support
* CI/CD usability
* Long-term maintenance

Then choose the best language.

### Important

Before implementing the CLI, present me with:

```text
CLI Language Decision

Option 1:
Pros:
Cons:

Option 2:
Pros:
Cons:

Option 3:
Pros:
Cons:

Recommendation:
Reason:
```

Ask for my approval before proceeding if the decision is significant.

---

# 16. CLI AUTHENTICATION

CLI login should be secure and pleasant.

Ideally:

```bash
secretmanagement login
```

opens a browser.

The user authenticates using Firebase.

The CLI receives a secure credential/token.

Research modern CLI authentication patterns such as:

* OAuth device authorization
* Browser-based authentication
* PKCE
* Loopback localhost callback
* Short-lived authorization codes

Choose the best approach.

Do NOT copy authentication tokens into terminal output.

Do NOT use long-lived Firebase ID tokens as permanent CLI credentials.

Use short-lived or appropriately scoped credentials.

Support:

```bash
secretmanagement logout
```

and credential revocation.

---

# 17. SECRET INJECTION

The most important CLI workflow should be:

```bash
secretmanagement run -- npm run dev
```

The CLI should:

1. Authenticate.
2. Determine the current project.
3. Determine the environment.
4. Verify permissions.
5. Fetch authorized secrets.
6. Decrypt only on the trusted side.
7. Inject secrets into the child process environment.
8. Start the process.
9. Remove sensitive values from memory where realistically possible.
10. Never print secret values.

Example:

```bash
secretmanagement run -- node server.js
```

should result in:

```text
process.env.DATABASE_URL
process.env.API_KEY
process.env.JWT_SECRET
```

being available to the process.

---

# 18. PROJECT CONFIGURATION FILE

Research whether the CLI should support a configuration file such as:

```text
.secretmanagement/
secretmanagement.yaml
secretmanagement.json
```

or a hidden project file.

The configuration should NOT contain secret values.

It may contain:

```yaml
project: my-project
environment: development
```

or an equivalent minimal representation.

Choose the best format.

Keep configuration extremely simple.

---

# 19. FRAMEWORK SUPPORT

The platform should work with:

### Next.js

Example:

```bash
secretmanagement run -- npm run dev
```

### React

Support Vite/React-style applications through environment injection.

### Node.js

Support:

```bash
secretmanagement run -- node server.js
```

### Go

Support:

```bash
secretmanagement run -- ./server
```

The CLI should fundamentally work by injecting environment variables.

Do not build framework-specific complexity unless necessary.

If useful, provide optional packages/integrations.

---

# 20. NPM PACKAGE

Evaluate whether an npm package is useful.

Potential package:

```text
@secretmanagement/client
```

or another appropriate name.

It could eventually support programmatic access.

Do not create it merely for the sake of having an npm package.

Only introduce it if there is a clear developer-experience benefit.

---

# 21. GO SUPPORT

The CLI should be capable of supporting Go applications naturally.

The developer should not need to modify their Go code.

Example:

```bash
secretmanagement run -- go run .
```

Secrets should appear as normal environment variables.

---

# 22. AUDIT LOGGING

Audit logs are a core feature.

Log security-sensitive events such as:

```text
User login
User logout
Failed login
Project created
Project deleted
Environment created
Environment deleted
Secret created
Secret updated
Secret deleted
Secret accessed
Member invited
Member removed
Role changed
Permission changed
CLI token created
CLI token revoked
Access denied
```

But NEVER log secret values.

---

# 23. AUDIT LOG ARCHITECTURE

The user specifically wants a better stack for logs.

Research and propose the best architecture.

Start with PostgreSQL if it is sufficient.

Consider:

* Append-only audit table
* Partitioning
* Indexing
* Structured JSON metadata
* Immutable event records
* Retention policies
* Future external log pipeline

Potential schema:

```text
audit_logs

id
organization_id
actor_id
action
resource_type
resource_id
project_id
environment_id
ip_address
user_agent
metadata
created_at
```

But improve this schema after research.

Audit logs should be:

* Queryable
* Reliable
* Tamper-resistant
* Structured
* Fast

Do not over-engineer the initial implementation.

---

# 24. AUDIT LOG UI

Provide:

```text
Audit Logs
```

with:

* Search
* Filters
* Actor
* Action
* Project
* Environment
* Date
* Resource
* Success/failure

Example:

```text
Nitheesh
Updated secret
DATABASE_URL
Production
2 minutes ago
```

But never display the secret value.

---

# 25. SECURITY REQUIREMENTS

Treat this as a security-sensitive infrastructure product.

Implement:

## Authentication security

* Secure sessions
* Token validation
* Token expiration
* Revocation
* Secure cookies where applicable
* CSRF protection where applicable
* OAuth security
* Password reset security
* Email verification where appropriate

## Authorization

Every protected server-side operation must perform authorization.

Never trust:

```text
projectId
environmentId
userId
role
```

coming from the browser.

Always derive identity from verified authentication.

---

# 26. IDOR PROTECTION

Explicitly defend against:

```text
User A changes projectId
User A accesses User B's project
```

Every resource query must enforce ownership/membership/access control.

Review the application specifically for:

* IDOR
* BOLA
* privilege escalation
* horizontal authorization bugs
* vertical authorization bugs

---

# 27. API SECURITY

Implement:

* Input validation
* Schema validation
* Request size limits
* Rate limiting
* Authentication
* Authorization
* Secure error responses
* CORS policy
* Content security policy where applicable
* Security headers
* Request correlation IDs
* Abuse prevention

Use a modern validation library compatible with Cloudflare Workers.

Consider Zod or an equivalent.

---

# 28. RATE LIMITING

Because Redis is not being used, research Cloudflare-native approaches.

Consider:

* Cloudflare rate limiting
* Durable Objects
* Workers primitives
* Database-backed limits for lower-volume operations

Do not implement a database-based rate limiter for every request if Cloudflare can handle it more efficiently.

Different endpoints should have different limits.

For example:

```text
Login:
strict

Secret retrieval:
strict

Audit logs:
moderate

Public landing page:
high

Project reads:
moderate
```

---

# 29. SECRET EXPOSURE PROTECTION

Prevent accidental exposure through:

* Logs
* Errors
* URLs
* Query strings
* Browser local storage
* Analytics
* Monitoring
* Client-side state
* React server/client boundaries
* Server errors
* CLI output

Never put secret values into URLs.

Never return unnecessary secret values to the browser.

---

# 30. DATABASE SECURITY

Use:

* Foreign keys
* Unique constraints
* Check constraints where useful
* Transactions
* Parameterized queries
* Least-privilege DB credentials
* Connection security
* Migration system

Research whether PostgreSQL Row Level Security should be used.

If not, document why authorization is safely enforced at the application layer.

---

# 31. OPEN SOURCE

The entire project should be designed as an open-source project.

Create:

```text
LICENSE
README.md
CONTRIBUTING.md
SECURITY.md
CODE_OF_CONDUCT.md
CHANGELOG.md
```

Also provide:

```text
docs/
```

with:

```text
architecture.md
security.md
cli.md
self-hosting.md
development.md
database.md
authentication.md
authorization.md
encryption.md
```

---

# 32. REPOSITORY STRUCTURE

The exact structure should be decided after research.

A possible structure:

```text
SecretManagement/
│
├── apps/
│   └── web/
│
├── cli/
│
├── packages/
│   ├── shared/
│   ├── validation/
│   └── ...
│
├── database/
│
├── docs/
│
├── scripts/
│
├── tests/
│
├── README.md
├── SECURITY.md
├── LICENSE
└── ...
```

However, do not blindly follow this.

Research whether a monorepo is appropriate.

Possible options:

```text
SecretManagement_nextjs
SecretManagement_cli
```

or:

```text
SecretManagement/
  web/
  cli/
```

Choose the structure that provides the best long-term developer experience.

---

# 33. NEXT.JS

Use:

* Next.js
* TypeScript
* App Router
* React Server Components where appropriate
* Server Actions where appropriate
* Route Handlers where appropriate

Avoid unnecessary client components.

Keep the Worker bundle small.

Do not use Node-specific packages that cannot execute in Cloudflare Workers.

---

# 34. UI

Use:

## shadcn/ui

Use:

* shadcn/ui
* Tailwind CSS
* accessible components
* clean typography
* responsive layout

Support:

* Light theme
* Dark theme
* System theme

Use subtle animation.

Do NOT over-animate the application.

Animations should communicate:

* Loading
* State changes
* Navigation
* Success
* Error
* Dialog transitions

Avoid flashy animations.

---

# 35. DESIGN DIRECTION

The visual language should take inspiration from:

* Doppler
* Phase
* Modern developer tools
* Modern cloud infrastructure products

Do not clone their designs.

Create an original visual identity.

The interface should feel:

* Premium
* Trustworthy
* Modern
* Technical
* Advanced
* Calm
* Reliable
* Developer-focused

The application should NOT look like a generic admin dashboard.

---

# 36. COLOR SYSTEM

Do not arbitrarily select a color.

Research color psychology and modern developer infrastructure branding.

Evaluate color palettes based on:

* Trust
* Security
* Reliability
* Innovation
* Premium feel
* Modern technology
* Accessibility
* WCAG contrast
* Dark mode compatibility
* Brand recognition

Consider whether gradients should be used.

If gradients are used, keep them subtle.

Choose a primary brand color and supporting palette after research.

Document:

```text
Why this color?
Why this palette?
How does it communicate trust?
How does it work in dark mode?
```

---

# 37. LANDING PAGE

Create a polished landing page.

Sections:

### Hero

Clear message explaining what SecretManagement does.

Example positioning:

> Simple, secure secret management for modern development teams.

Do not blindly use this copy.

Create better copy after researching the product positioning.

### Features

Explain:

* Secure secrets
* Environment management
* Team access
* CLI
* Audit logs
* Developer experience

### How it works

```text
Create Project
      ↓
Add Environment
      ↓
Add Secrets
      ↓
Install CLI
      ↓
Run Your Application
```

### CLI example

Show realistic terminal usage.

### Security

Explain security architecture in accessible language.

### Open source

Explain that the project is open source.

### CTA

```text
Get Started
View on GitHub
```

### Footer

Include:

* Documentation
* GitHub
* Security
* Privacy
* Terms
* Contact
* Playxoft

---

# 38. DASHBOARD INFORMATION ARCHITECTURE

After login:

```text
Dashboard

Projects
Teams
Audit Logs
Settings
```

Inside project:

```text
Project
├── Overview
├── Environments
│   ├── Development
│   ├── Staging
│   └── Production
├── Secrets
├── Members
├── Access
└── Settings
```

Keep navigation simple.

---

# 39. SECRET UI

The secret interface should be extremely clean.

Example:

```text
DATABASE_URL        ••••••••••••••••
API_KEY              ••••••••••••••••
STRIPE_SECRET_KEY    ••••••••••••••••
```

Actions:

```text
Reveal
Copy
Edit
Delete
Rotate
```

Require appropriate permissions for each action.

Consider:

* masking by default
* clipboard protection
* confirmation for dangerous operations
* warning before copying production secrets

Do not create annoying security UX.

---

# 40. ENVIRONMENT SWITCHING

Environment selection should be obvious.

Example:

```text
Project: My App

Environment:
[ Development ▼ ]
```

Switching environments should update the secret list and related project context.

Do not accidentally show production secrets when the developer thinks they are viewing development.

Make environment context visually obvious.

---

# 41. PRODUCTION SAFETY

Production environments should have stronger safeguards.

Consider:

* Explicit production indicator
* Confirmation for destructive operations
* Higher permission requirements
* Audit events
* Optional approval workflows in future

Do not make production unusable.

---

# 42. TEAM MANAGEMENT

Provide:

```text
Members

Name
Email
Role
Seats
Projects
Environments
Status
Actions
```

Admin can:

* Invite member
* Remove member
* Change role
* Assign projects
* Assign environments
* Assign permissions
* Assign seat

---

# 43. INVITATIONS

Implement secure invitations.

Invitation flow:

```text
Admin
 ↓
Invite email
 ↓
Secure invitation token
 ↓
User opens invitation
 ↓
Authenticates
 ↓
Joins organization
```

Invitation tokens must:

* Expire
* Be single-use
* Be securely generated
* Never be stored in plaintext if avoidable
* Be revocable

---

# 44. ERROR HANDLING

Errors should be understandable.

Bad:

```text
Error 403
```

Better:

```text
You don't have permission to access this environment.
Ask your organization administrator for access.
```

Do not leak internal details.

Never expose:

* Database errors
* Stack traces
* Encryption details
* Secret values
* Internal tokens

to end users.

---

# 45. OBSERVABILITY

Research the best lightweight observability approach compatible with Cloudflare Workers.

Implement:

* Structured application logs
* Request IDs
* Error monitoring
* Performance metrics
* Security events

Do not accidentally log secrets.

---

# 46. TESTING

Testing is mandatory.

Implement:

## Unit tests

For:

* Encryption
* Decryption
* Authorization
* Permission evaluation
* Validation
* Secret naming
* CLI configuration
* Token handling

## Integration tests

For:

* Authentication
* Projects
* Environments
* Secrets
* Teams
* Permissions
* Audit logs
* CLI API

## Security tests

Explicitly test:

* IDOR
* privilege escalation
* unauthorized secret access
* expired credentials
* revoked credentials
* deleted member access
* cross-project access
* cross-environment access
* production access
* invitation reuse
* token replay

## End-to-end tests

Test major user flows.

---

# 47. DATABASE MIGRATIONS

Use a proper migration system.

Never manually modify production schemas.

Provide:

```bash
db generate
db migrate
db seed
```

or equivalent commands.

Document the workflow.

---

# 48. DEVELOPMENT ENVIRONMENT

The project should be easy to run locally.

Ideally:

```bash
git clone ...
npm install
cp .env.example .env
npm run dev
```

Document all required services.

Do not require Redis.

Do not require unnecessary infrastructure.

---

# 49. ENVIRONMENT VARIABLES

Create:

```text
.env.example
```

Document every variable.

Categorize:

```text
Authentication
Database
Encryption
Cloudflare
Application
CLI
Observability
```

Never commit real credentials.

---

# 50. SECURITY REVIEW PHASE

Before considering the product complete, perform a dedicated security review.

Act as an external security engineer.

Look for:

* Authentication bypass
* Authorization bypass
* IDOR
* SSRF
* XSS
* CSRF
* SQL injection
* Command injection
* Path traversal
* Token leakage
* Secret leakage
* Cryptographic mistakes
* Replay attacks
* Race conditions
* Privilege escalation
* Insecure direct object references
* Improper error handling
* Rate-limit bypass
* Invitation abuse
* Session fixation
* Account takeover
* OAuth misconfiguration
* CLI credential theft

Fix findings before finalizing.

---

# 51. THREAT MODEL

Create a threat model.

At minimum consider:

### Attacker types

1. Unauthenticated attacker
2. Authenticated malicious user
3. Compromised team member
4. Compromised administrator
5. Stolen CLI credential
6. Compromised browser
7. Database compromise
8. Application compromise
9. Insider
10. Supply-chain attacker

For each:

```text
Threat
Impact
Likelihood
Mitigation
Residual risk
```

Document this in:

```text
docs/security/threat-model.md
```

---

# 52. SECRET ROTATION

Design secret rotation properly.

At minimum support manual rotation:

```text
Rotate secret
```

Future architecture should allow automated rotation.

Do not pretend the platform can automatically rotate third-party credentials unless integrations exist.

---

# 53. VERSIONING

Secrets should have metadata allowing future versioning.

Consider:

```text
secret
secret_version
```

This enables:

* Rotation
* Rollback
* Audit history
* Future recovery

Do not expose historical plaintext values unnecessarily.

---

# 54. DELETE BEHAVIOR

Secret deletion must be carefully designed.

Research:

* Soft deletion
* Cryptographic deletion
* Secret version deletion
* Audit requirements

A deleted secret should not remain accidentally retrievable.

However, audit logs may retain the fact that a secret existed without retaining its value.

---

# 55. CLI SECURITY

The CLI must never:

* Print secrets by default.
* Put tokens in command history.
* Put tokens in URLs.
* Store credentials insecurely.
* Log authorization headers.
* Write secrets to temporary files unnecessarily.

If credentials must be persisted locally, use the operating system's secure credential storage where practical.

Research:

* macOS Keychain
* Windows Credential Manager
* Linux Secret Service/keyring

Choose a cross-platform strategy appropriate for the selected CLI language.

---

# 56. CI/CD SUPPORT

Design the CLI so future CI usage is possible.

Potential future workflow:

```bash
SECRET_MANAGEMENT_TOKEN=...
secretmanagement run -- npm run build
```

Support scoped machine/service credentials in a future-compatible architecture.

Do not mix personal credentials with CI credentials.

---

# 57. SELF-HOSTING

Because this is open source, research how users could self-host.

Document:

```text
Cloudflare Workers
Neon PostgreSQL
Firebase Authentication
```

and required configuration.

The architecture should not intentionally lock the project into Playxoft infrastructure.

Playxoft may provide the hosted service, but the open-source project should remain useful independently.

---

# 58. HOSTED VERSION

The hosted version will be powered by Playxoft.

Branding should be subtle and professional.

Use:

```text
Powered by Playxoft
```

where appropriate.

Do not make the application feel like an internal Playxoft dashboard.

---

# 59. PRIVACY

Do not collect unnecessary user data.

Avoid unnecessary analytics.

Do not collect secret values.

Clearly document:

* What information is stored.
* What is encrypted.
* What audit information is stored.
* What telemetry exists.
* What the hosted service can access.

---

# 60. PERFORMANCE

Optimize aggressively for Cloudflare Workers.

Priorities:

```text
Small bundle
Low CPU
Low latency
Few database queries
Minimal dependencies
Fast startup
```

Avoid:

* Heavy server-side libraries
* Node-only dependencies
* Large utility packages
* Unnecessary middleware
* Excessive serialization
* N+1 queries

Use database indexes properly.

---

# 61. API DESIGN

Create a clean internal API architecture.

Possible structure:

```text
/api/auth
/api/projects
/api/projects/:id
/api/projects/:id/environments
/api/projects/:id/secrets
/api/organizations
/api/members
/api/roles
/api/audit
/api/cli
```

But determine the best structure.

Keep API semantics consistent.

Use appropriate HTTP methods.

---

# 62. TYPES

Use TypeScript throughout the web application.

Avoid:

```text
any
```

unless absolutely necessary.

Create shared types/schemas where useful.

Prefer schema-derived types when practical.

---

# 63. CODE QUALITY

Follow strong engineering standards.

Requirements:

* TypeScript strict mode
* ESLint
* Formatter
* Clear naming
* Small functions
* Strong typing
* No unnecessary abstraction
* No duplicated authorization logic
* No duplicated validation
* No magic security constants

Security-sensitive code should be especially easy to review.

---

# 64. DOCUMENTATION

Every major architectural decision should be documented.

Create:

```text
docs/
├── architecture/
├── security/
├── cli/
├── database/
├── authentication/
├── authorization/
├── deployment/
└── development/
```

Create an ADR folder if useful:

```text
docs/adr/
```

For major decisions document:

```text
Context
Options
Decision
Reason
Tradeoffs
```

---

# 65. IMPLEMENTATION PHASES

Do NOT attempt to build everything at once.

Implement in phases.

---

## PHASE 0 — Research & Architecture

Before writing substantial code:

Research:

* Cloudflare Workers current limits
* Cloudflare security capabilities
* Neon PostgreSQL
* Firebase Auth
* Secret-management architecture
* Doppler UX
* Phase UX
* Open-source alternatives
* CLI authentication patterns
* Encryption architecture
* RBAC/ABAC
* Audit logging
* Cloudflare-native rate limiting
* Cross-platform CLI languages

Produce:

```text
docs/architecture/decision-record.md
docs/security/threat-model.md
docs/architecture/system-architecture.md
```

Create architecture diagrams.

Then present the most important decisions to me.

---

# PHASE 1 — Repository Foundation

Set up:

* Repository
* Monorepo if appropriate
* Next.js
* TypeScript
* App Router
* Tailwind
* shadcn/ui
* Theme system
* ESLint
* Formatter
* Testing
* Database tooling
* Cloudflare deployment tooling

Create:

```text
.env.example
README.md
LICENSE
SECURITY.md
CONTRIBUTING.md
```

Do not implement secrets yet.

---

# PHASE 2 — Authentication

Implement Firebase:

* Google login
* Email/password
* Logout
* Forgot password
* Password reset
* Session handling
* Protected routes

Create the account model.

Test authentication thoroughly.

---

# PHASE 3 — Organization & Team System

Implement:

* Organizations
* Membership
* Invitations
* Roles
* Permissions
* Seats
* Project access
* Environment access

Build the authorization engine before building sensitive secret APIs.

---

# PHASE 4 — Projects & Environments

Implement:

```text
Organization
 → Project
   → Environment
```

Support CRUD.

Add permission enforcement.

---

# PHASE 5 — Cryptographic Secret Storage

This is a critical phase.

Implement:

* Encryption
* Decryption
* Key versioning
* Key management
* Secret versioning
* Rotation
* Secure deletion strategy

Write extensive tests.

Perform a security review before continuing.

---

# PHASE 6 — Secret Management UI

Implement:

* Add secret
* Edit secret
* Delete secret
* Reveal
* Copy
* Rotate
* Search
* Filter
* Environment switching

Make the UX extremely simple.

---

# PHASE 7 — Audit Logs

Implement:

* Structured audit events
* Append-only design where appropriate
* Search
* Filters
* Actor
* Project
* Environment
* Action
* Timestamp

Ensure secret values NEVER enter audit logs.

---

# PHASE 8 — CLI Architecture

Research and select CLI language.

Present decision.

After approval:

Create:

```text
cli/
```

Implement:

```bash
secretmanagement login
secretmanagement logout
secretmanagement projects
secretmanagement environments
secretmanagement secrets
secretmanagement pull
secretmanagement run
```

---

# PHASE 9 — CLI Authentication

Implement secure browser authentication.

Use a modern secure flow.

Implement:

```bash
secretmanagement login
```

and:

```bash
secretmanagement logout
```

Add:

* Credential storage
* Token expiration
* Revocation
* Error handling

---

# PHASE 10 — CLI Secret Injection

Implement:

```bash
secretmanagement run -- npm run dev
secretmanagement run -- node server.js
secretmanagement run -- go run .
```

This phase should receive especially extensive testing.

---

# PHASE 11 — Developer Experience

Add:

* Project config
* Environment selection
* Helpful CLI errors
* Shell-friendly output
* CI-friendly authentication
* Documentation
* Next.js examples
* React examples
* Node.js examples
* Go examples

---

# PHASE 12 — Landing Page

Create a world-class landing page.

Focus on:

* Trust
* Security
* Simplicity
* Developer experience
* CLI
* Open source
* Teams

Add subtle animations.

Ensure excellent mobile responsiveness.

---

# PHASE 13 — Design Polish

Perform a complete UX review.

Check:

* Typography
* Spacing
* Colors
* Dark mode
* Light mode
* Accessibility
* Keyboard navigation
* Loading states
* Empty states
* Error states
* Confirmation dialogs
* Responsive behavior

Compare UX against high-quality developer tools.

---

# PHASE 14 — Security Audit

Perform a dedicated security audit.

Attempt to break the application.

Test:

```text
IDOR
BOLA
RBAC bypass
Authentication bypass
Privilege escalation
Token replay
Token theft
Invitation abuse
Cross-project access
Cross-environment access
Production access
Secret leakage
SQL injection
XSS
CSRF
SSRF
Command injection
Rate-limit bypass
```

Fix everything discovered.

---

# PHASE 15 — Performance Audit

Measure:

* Worker bundle size
* CPU time
* Database latency
* Number of DB queries
* API latency
* CLI startup time
* Secret retrieval time

Remove unnecessary dependencies.

Optimize database queries.

Ensure compatibility with the actual Cloudflare limits discovered during Phase 0.

---

# PHASE 16 — Production Readiness

Prepare:

* Production environment
* Database migrations
* Cloudflare deployment
* Firebase production configuration
* Secret/key configuration
* Monitoring
* Error reporting
* Security policies
* Backup strategy
* Recovery documentation

Create:

```text
docs/deployment/production.md
docs/deployment/self-hosting.md
```

---

# PHASE 17 — Final Review

Before declaring the project complete, review it as:

### Developer

Is the CLI pleasant?

### Designer

Is the UI simple?

### Security engineer

Can secrets be accessed improperly?

### DevOps engineer

Can it survive production?

### Open-source maintainer

Can someone else understand and contribute to it?

### Product designer

Does it solve the problem without unnecessary complexity?

### CTO

Can this architecture scale?

Fix problems discovered during this review.

---

# 66. REQUIRED FINAL OUTPUT FROM CLAUDE

After each major phase, report:

```text
Phase:
Status:

Implemented:
- ...
- ...

Architecture decisions:
- ...
- ...

Files changed:
- ...
- ...

Security considerations:
- ...
- ...

Tests:
- ...

Known limitations:
- ...

Next phase:
- ...
```

Do not simply say:

> "Phase completed."

Give useful engineering information.

---

# 67. IMPORTANT IMPLEMENTATION RULES

## Rule 1

Do not over-engineer.

## Rule 2

Do not introduce Redis unless a specific requirement proves it necessary.

## Rule 3

Do not implement custom cryptography.

## Rule 4

Do not store plaintext secrets.

## Rule 5

Never log secret values.

## Rule 6

Never trust client-provided authorization information.

## Rule 7

Every secret access must be authorized.

## Rule 8

Every security-sensitive action should be auditable.

## Rule 9

Do not expose internal errors.

## Rule 10

Do not use dependencies that are incompatible with Cloudflare Workers.

## Rule 11

Prefer Web APIs in Worker code.

## Rule 12

Do not create unnecessary client components.

## Rule 13

Do not create an unnecessarily complicated microservice architecture.

## Rule 14

Keep the initial system as a modular monolith.

## Rule 15

Design clear boundaries so components can be extracted later if necessary.

## Rule 16

Do not blindly copy Doppler or Phase.

## Rule 17

The product should have its own identity.

## Rule 18

Security decisions require documentation.

## Rule 19

Major architecture decisions require my approval.

## Rule 20

If you are uncertain, research before implementing.

---

# 68. INITIAL ARCHITECTURAL PRINCIPLE

The initial architecture should preferably be:

```text
                         ┌─────────────────────┐
                         │     Web Browser     │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Cloudflare Workers  │
                         │    Next.js App      │
                         │                     │
                         │ Auth                │
                         │ Authorization       │
                         │ API                 │
                         │ Encryption          │
                         │ Audit               │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Neon PostgreSQL     │
                         │                     │
                         │ Organizations       │
                         │ Projects            │
                         │ Environments        │
                         │ Encrypted Secrets   │
                         │ Members             │
                         │ Permissions         │
                         │ Audit Logs          │
                         └─────────────────────┘


        ┌─────────────────────┐
        │      CLI            │
        │                     │
        │ Go / Rust / TS      │
        └──────────┬──────────┘
                   │
                   │ HTTPS
                   ▼
        ┌─────────────────────┐
        │ Cloudflare Workers  │
        └──────────┬──────────┘
                   │
                   ▼
             Authorized
             Secret Access
                   │
                   ▼
          Environment Injection
                   │
                   ▼
        ┌─────────────────────┐
        │ Developer Process   │
        │                     │
        │ Next.js             │
        │ React               │
        │ Node.js             │
        │ Go                  │
        └─────────────────────┘
```

This is only a starting architectural model.

Improve it if research identifies a significantly better approach.

---

# 69. WHAT NOT TO BUILD INITIALLY

Do NOT initially build:

* Billing
* Marketplace
* Hundreds of integrations
* Kubernetes operator
* Complex microservices
* Redis infrastructure
* Complex analytics
* AI features
* Automatic third-party secret rotation
* Excessive notification systems
* Enterprise SSO/SAML unless architecture requires preparation for it
* Complex workflow engines

Build the core extremely well first.

---

# 70. MVP DEFINITION

The MVP is complete when a developer can:

```text
1. Open website
2. Sign in with Google
3. Create organization
4. Create project
5. Create environment
6. Add secrets
7. Invite another user
8. Assign project/environment permissions
9. Install CLI
10. Login from CLI
11. Select project/environment
12. Run:
       secretmanagement run -- npm run dev
13. Application receives environment variables
14. Actions appear in audit logs
15. Unauthorized users cannot access secrets
```

This flow must be extremely polished.

---

# 71. GOLDEN USER EXPERIENCE

The ideal first-time experience should feel like:

```text
Create account
      ↓
Create project
      ↓
Choose Development
      ↓
Add DATABASE_URL
      ↓
Add API_KEY
      ↓
Install CLI
      ↓
secretmanagement login
      ↓
secretmanagement run -- npm run dev
      ↓
Done.
```

The user should not need to understand:

* Encryption
* Key hierarchies
* RBAC
* Database architecture
* Cloudflare Workers
* Firebase tokens

unless they intentionally open the advanced/security documentation.

---

# 72. FINAL INSTRUCTION

You are not merely generating a demo.

Build the foundation of a real open-source security product.

Prioritize:

```text
Security
Reliability
Simplicity
Developer Experience
Performance
Maintainability
Open Source
```

in that order, while maintaining a premium user experience.

When there is a conflict:

1. Security wins over convenience.
2. Correctness wins over speed of implementation.
3. Simplicity wins over unnecessary architecture.
4. Cloudflare compatibility wins over Node-specific convenience.
5. Developer experience wins over unnecessary complexity.
6. Long-term maintainability wins over short-term hacks.

Do not hide architectural uncertainty.

When an important decision is uncertain:

```text
Research
→ Compare
→ Explain
→ Recommend
→ Ask for approval
→ Implement
```

Do not proceed with a major irreversible architectural decision without approval.

Start with **PHASE 0 — Research & Architecture**.

Do not start by generating the entire application.

First understand the problem, research the current ecosystem, design the architecture, identify security risks, choose the technology decisions, and present the Phase 0 findings for approval.
