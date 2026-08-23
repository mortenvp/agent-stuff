# Agent Stuff

Personal [Pi Coding Agent](https://buildwithpi.ai/) package containing reusable extensions, skills, prompt commands, and themes.

## Install

Install from a local checkout while developing:

```sh
pi install /absolute/path/to/agent-stuff
```

Install from Git on another machine:

```sh
pi install git:github.com/mortenvp/agent-stuff@main
```

After changing an installed Git package, run the install command again to update it. During local development, use `/reload` in Pi after edits.

## Contents

- [`commands/discuss.md`](commands/discuss.md): `/discuss`, a planning-interviewer mode that clarifies an idea before implementation. Adapted from [Armin Ronacher's `agent-stuff`](https://github.com/mitsuhiko/agent-stuff).
- [`extensions/worktree.ts`](extensions/worktree.ts): `/worktree`, an interactive workflow for safely creating or continuing Git worktrees and switching Pi to the selected worktree. New branches get editable defaults for a concise branch name, the `origin/HEAD` base, and the worktree path.
- [`extensions/answer.ts`](extensions/answer.ts): `/answer`, an interactive Q&A flow for answering questions extracted from the last assistant message.
- [`extensions/review.ts`](extensions/review.ts): `/review` and `/end-review`, an isolated conversation-branch workflow for reviewing uncommitted changes, the current branch against a base branch, commits, pull requests, or folder snapshots. Copied from [Armin Ronacher's review extension](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/review.ts) under its [Apache 2.0 license](licenses/mitsuhiko-agent-stuff-APACHE-2.0.txt).
- [`extensions/merge-pr.ts`](extensions/merge-pr.ts): `/merge-pr [PR-number-or-URL]`, a guarded workflow that monitors an existing pull request and squash-merges its confirmed head SHA only after CI passes.

## Review the current branch

From a feature-branch worktree, run:

```text
/review branch main
```

Replace `main` with the branch you intend to merge into. Choose **Empty branch** to perform the review in an isolated Pi conversation branch; this does not create or switch Git branches or worktrees. Finish with `/end-review` to return, summarize the findings, or queue fixes. Running `/review` without arguments opens an interactive target selector.

## Merge a pull request

Run `/merge-pr` from a branch with an existing pull request, or provide a PR number or URL:

```text
/merge-pr
/merge-pr 42
/merge-pr https://github.com/owner/repository/pull/42
```

The command requires an interactive Pi session and an authenticated `gh` CLI. It confirms the exact pull request and head SHA, requires the matching local branch to be clean and fully pushed, requires at least one CI check, accepts passed and skipped checks, and polls pending checks every 10 seconds until completion or cancellation. It stops without merging if local changes appear, local commits are not pushed, CI fails, the pull request changes, or GitHub reports a merge blocker. Successful pull requests are squash-merged without bypassing branch protection.

## Credits

Thanks to [Armin Ronacher](https://github.com/mitsuhiko) for the work in [his `agent-stuff` repository](https://github.com/mitsuhiko/agent-stuff), on which parts of this package are based.

## Layout

- `extensions/` — TypeScript extensions
- `skills/` — skills (`SKILL.md` directories)
- `commands/` — Markdown prompt commands
- `themes/` — JSON themes
