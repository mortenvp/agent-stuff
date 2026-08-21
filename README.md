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

## Layout

- `extensions/` — TypeScript extensions
- `skills/` — skills (`SKILL.md` directories)
- `commands/` — Markdown prompt commands
- `themes/` — JSON themes
