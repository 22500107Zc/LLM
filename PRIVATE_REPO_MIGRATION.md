# Moving this repository to a private one

**Status: not done. It needs one action only you can take.**

## Why it cannot be done in place

`22500107Zc/LLM` is a **public fork** of `Mintplex-Labs/anything-llm`. GitHub
does not allow a fork's visibility to be switched to private while the fork
relationship exists. The commercial history therefore has to move to a new
private repository rather than be hidden where it is.

## Why this session could not finish it

Two attempts were made and both were refused by the execution environment, not
by GitHub and not by a missing permission on your account:

```
POST /user/repos
  -> "This GitHub API path is not available: sessions are bound to their
      configured repositories."

PATCH /repos/22500107Zc/LLM  {"private": true}
  -> "Repository settings writes are not permitted through this proxy."
```

This session can push commits to the repository it was given. It cannot create
a repository or change repository settings.

## Current state

| | |
| --- | --- |
| `22500107Zc/LLM` | **public**, a fork of `Mintplex-Labs/anything-llm` |
| `master` on it | untouched upstream code, no commercial content |
| `claude/commercial-b2b-ai-platform-0skp39` | **all 13 commercial commits — currently public** |

The commercial work is on the branch, not on `master`. Removing that branch
from the public fork removes every commercial commit from public view and
leaves an ordinary upstream fork behind.

## Finishing it — two steps

**1. Create the private repository** (browser, about thirty seconds):

- Go to https://github.com/new
- Owner `22500107Zc`, name `business-ai-operations-platform`
- **Private**
- Do **not** add a README, .gitignore or licence — it must be empty

**2. Run the migration** from this clone:

```bash
export GITHUB_TOKEN=<a token with repo scope>

# See exactly what it would do, change nothing:
./scripts/migrate-to-private-repo.sh --dry-run 22500107Zc/business-ai-operations-platform

# Copy and verify. This deletes nothing:
./scripts/migrate-to-private-repo.sh 22500107Zc/business-ai-operations-platform
```

Once you are satisfied the private copy is complete, removing the public
branch is a separate, explicit step:

```bash
./scripts/migrate-to-private-repo.sh --remove-public 22500107Zc/business-ai-operations-platform
```

The script:

1. **Refuses** unless the target exists and is private, so commercial code can
   never be pushed to a public repository by mistake.
2. Pushes every branch and every tag, so the full history and the `LICENSE`
   and `NOTICE` files travel with it.
3. Verifies commit parity **twice**, independently — matching SHA and matching
   commit count — and confirms `LICENSE` and `NOTICE` are present in the
   pushed history.
4. Repoints this clone's `origin` at the private repository.
5. Stops there. **It deletes nothing** unless you run it again with
   `--remove-public`, which asks you to type the public repository's name
   before touching it.

If any check fails it stops and deletes nothing, so the commercial history is
never in only one place.

## What removing the public branch does, and does not, do

Deleting the branch removes it from the public repository. It does **not**
retract commits that were already published. Forks, clones, GitHub's cached
commit views and any third-party mirror may still hold them.

Treat anything that was ever public as public. A private repository protects
**future** development; it cannot un-publish past work. If a real credential
was ever committed, rotate it — do not rely on deletion.

## Afterwards

- Confirm the new repository shows **Private** at
  `https://github.com/22500107Zc/business-ai-operations-platform`
- Confirm `https://github.com/22500107Zc/LLM/branches` no longer lists
  `claude/commercial-b2b-ai-platform-0skp39`
- `git remote -v` in this clone should point at the private repository

**Never give the repository URL to a customer.** They receive a running
deployment at their own domain, not source code.
