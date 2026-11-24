# Agent Team — Steel Yard Ledger — Alpha

Six project-level OpenCode agents are defined in
[`.opencode/agents/`](../.opencode/agents/). They can be selected as primary
agents or launched as subagents from the main session.

| Agent | ID | Role | Can modify files? |
| --- | --- | --- | --- |
| Online Auditor | `online-auditor` | Live uptime, HTTPS, SEO, public pages | **No** (read-only) |
| Security Guard | `security-guard` | Auth, CSRF, headers, Firestore rules, secrets | **No** (read-only) |
| Backend Developer | `backend-dev` | Express routes, Firestore store, auth, config | Yes, **asks first** |
| Frontend Developer | `frontend-dev` | Views, public assets, branding, accessibility | Yes, **asks first** |
| QA Runner | `qa-runner` | Unit/customer/security/smoke suites | **No** (read-only) |
| Deployment Operator | `deploy-operator` | Fly.io, GitHub, SMTP, Search Console | Yes, **asks first** |

## Permission policy

- Read-only agents (`online-auditor`, `security-guard`, `qa-runner`) have
  `edit: deny`, so they cannot change source files.
- Modifying agents (`backend-dev`, `frontend-dev`, `deploy-operator`) have
  `edit: ask` and `shell: ask`. OpenCode will prompt you before every write or
  shell command. Choosing **Reject** stops the operation.
- All agents have `question: allow`, so they must explain the proposed change
  and wait for approval.
- No agent stores credentials. Secrets live only in Fly secrets and the
  git-ignored `data/` directory.

## How to use

Primary agent (select in the TUI):

```text
/agent online-auditor
```

Or ask the main agent to delegate:

```text
Use the security-guard subagent to review the current auth code.
Use the qa-runner subagent to run all four test suites.
Use the backend-dev subagent to fix the finding and ask me before editing.
```

Agents are chosen by their `description`, so the wording above helps the main
agent pick the right one.

## Recommended workflow

1. `online-auditor` → confirm the public site is healthy and indexable.
2. `security-guard` → review code and live security headers.
3. `qa-runner` → run all suites and report regressions.
4. `backend-dev` / `frontend-dev` → implement fixes, asking before each edit.
5. `qa-runner` → re-run tests.
6. `deploy-operator` → commit, push and deploy, asking before each external
   change; then `online-auditor` verifies the live URL again.

## Live references

- App: https://steel-yard-ledger.fly.dev
- Health: https://steel-yard-ledger.fly.dev/api/health
- Repository: https://github.com/yeswanthreddy7560-lab/steel-yard-ledger
- Deployment runbook: [DEPLOY-FLY.md](DEPLOY-FLY.md)
