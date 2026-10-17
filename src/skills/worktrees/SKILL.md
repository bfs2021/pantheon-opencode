---
name: worktrees
description: Git worktrees as safe, isolated coding lanes for risky or parallel work without affecting the main workspace
---

# Worktrees

Use git worktrees to create isolated working directories for parallel or experimental changes.

## When to Use

- Working on 2+ features simultaneously
- Risky refactoring that shouldn't affect the main workspace
- Reviewing a PR while keeping current work intact
- Running long-lived experiments

## Setup

Use this persistent external default for new worktrees:

```text
<project-parent>/.pantheon-worktrees/<exact-repository-directory-basename>/<task>
```

Resolve the project directory to an absolute path, then use its exact final
directory basename as the repository component; spaces are valid and must not
be normalized into a potentially colliding slug. For example, a project at
`/home/user/My Project` uses
`/home/user/.pantheon-worktrees/My Project/feature-name`. Replace
`<task>` with a short descriptive task name. This keeps worktrees outside
the project and reuses the same location across agent sessions.

```bash
# Create a worktree at the recommended external location
git worktree add "/home/user/.pantheon-worktrees/My Project/feature-name" task-branch

# List worktrees and their absolute paths
git worktree list --porcelain

# Only after the user explicitly authorizes removal, remove that exact worktree
git worktree remove "/home/user/.pantheon-worktrees/My Project/feature-name"

# Only after the user explicitly authorizes branch deletion
git branch -d task-branch
```

## Workflow

1. Resolve the project directory to an absolute path and create the worktree at `<project-parent>/.pantheon-worktrees/<exact-repository-directory-basename>/<task>`.
2. Work in the worktree directory
3. Commit and push from within the worktree
4. Leave the worktree and branch in place when the task is done unless the user explicitly authorizes removal or deletion.
5. If authorized, remove only the exact worktree path above; delete its branch only with separate explicit user authorization.

## Rules
- Never create worktrees inside the main project directory
- Use the persistent external default `<project-parent>/.pantheon-worktrees/<exact-repository-directory-basename>/<task>`
- Use the exact repository directory basename (spaces included); do not normalize it into a lossy slug
- Name worktrees descriptively, for example `feature-name` or `auth-refactor`
- Never remove a worktree or delete a branch unless the user explicitly authorizes that action
- Worktrees share the same git history — pushing from a worktree is the same as pushing from main
- Escalate to @iris for branch management if unsure
