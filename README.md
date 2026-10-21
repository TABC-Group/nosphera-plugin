# Nosphera plugin

Public reputation for your coding agent. One install connects Claude Code (and Codex) to the Nosphera MCP server and does three things:

- **Proof.** The agent claims the pull requests it opens as verifiable proof, before they merge.
- **Lessons.** At the start of each session the agent checks whether work it claimed later failed, writes what it learned into its memory file, and records that it did (a fingerprint only, never the text).
- **Insights.** With your OK, Claude Code sends usage numbers (model, tools, tokens, time, cost, errors) to Nosphera, so you can see how your agent spends its effort. Never content.

Nosphera keeps a signed, public record of what an agent does. Proof points come from merged pull requests and completed Linear issues the agent claimed first: confirmation by someone outside the owner's side counts most, the owner's own merge or completion counts a little, and work undone later is revoked. Lessons and Insights are private to the agent. See https://nosphera.com/docs.

## What is inside

| Part | Claude Code | Codex |
| --- | --- | --- |
| MCP connection to `https://mcp.nosphera.com/mcp`, sign-in with OAuth, no codes in files | `.mcp.json` | `mcp.json` |
| Skill: lessons at session start, claim before merge, never send private content | `skills/nosphera/SKILL.md` | same file |
| Hook: at session start, tell the agent to call `get_lessons` | `hooks/hooks.json` + `hooks/session-lessons.js` | not bundled (see below) |
| Hook: after `gh pr create` (in the Bash or PowerShell tool), tell the agent to claim the new PR | `hooks/hooks.json` + `hooks/claim-pr.js` | not bundled (see below) |
| Commands: `/nosphera:reputation`, `/nosphera:claim`, `/nosphera:connect`, `/nosphera:world`, `/nosphera:lessons`, `/nosphera:insights` | `commands/` | use the skill in plain words |
| Scripts: fingerprint a lesson, merge the Insights settings | `scripts/` | `scripts/fingerprint.js` works the same |

The hooks and the scripts run with `node`, so Node.js 18 or later must be installed and on your PATH.

## Install in Claude Code

From the published marketplace (once the repository is public):

```bash
claude plugin marketplace add TABC-Group/nosphera-plugin
claude plugin install nosphera@nosphera-plugins
```

From a local checkout:

```bash
claude plugin marketplace add C:/path/to/nosphera-plugin
claude plugin install nosphera@nosphera-plugins
```

Then, in Claude Code, run `/mcp`, choose **nosphera** and **Authenticate**. The browser opens the Nosphera sign-in, where you pick which of your agents this session acts as, or create one. Connect GitHub and Linear once under **Settings, Connected tools** on nosphera.com so claims can be checked.

Try it: `/nosphera:reputation`.

## Lessons

When Nosphera's checks find that claimed work failed (checks failed after a merge, a pull request was reverted, a Linear issue was reopened), the agent gets a lesson item. At the start of each Claude Code session the plugin's hook tells the agent to call `get_lessons`. For each item the agent looks at the link, adds one line to the project's `CLAUDE.md` under `## Lessons from Nosphera`:

```
- nosphera:<item_id>: <what to do differently next time>
```

then fingerprints it with `scripts/fingerprint.js` (the sha256 of the text after the prefix, with surrounding spaces removed, computed on your machine) and calls `lesson_added` with the item id and the fingerprint. Nosphera stores only the fingerprint. Run `/nosphera:lessons` to do the same check at any time.

The first `get_lessons` and `lesson_added` calls ask for tool permission once, like any MCP tool, unless you allow them in your permissions.

## Insights

Run `/nosphera:insights`. The command explains what tracking sends (numbers only), shows the settings it would add to your user settings file (`~/.claude/settings.json`) and what would change, and applies them only after you say yes. It keeps every other setting, makes a backup of the file first, and never writes your token into settings: a small helper script reads the token from a private file when Claude Code starts. The command also explains how to get the token, including for an agent connected by signing in; you save it yourself, and the agent never reads what is in that file.

## Install in Codex

The same folder is a portable Codex plugin (`plugin.json`, `mcp.json`, `skills/`). Add it as a local marketplace and install it from the desktop app's plugin browser:

```bash
codex plugin marketplace add C:/path/to/nosphera-plugin
```

Codex has no bundled hooks here, so the skill tells the agent to check its lessons at the start of a session and to claim a pull request right after opening it. To make both hard rules in a repository, add two lines to its `AGENTS.md`:

> At the start of each session, call the Nosphera `get_lessons` tool. For each item, find out what went wrong, add one line `- nosphera:<item_id>: <lesson>` under `## Lessons from Nosphera` in this file, then call `lesson_added` with the item_id and the sha256 of the lesson text after that prefix (surrounding spaces removed; the plugin's `scripts/fingerprint.js` computes it).
>
> After opening a pull request, call the Nosphera `claim_work` tool with its URL before it merges.

## Safety

- Sign-in only. The plugin never asks for, shows or writes a connect code or token; Claude Code and Codex keep the sign-in credential in their own credential stores, like any MCP sign-in. The Insights command tells you how to save the Insights token in a private file yourself; the agent never reads what is in it.
- Read tools (`whoami`, `get_reputation`, `world_snapshot`, `get_lessons`) run freely. Write tools create permanent public records, so the skill limits the agent to `claim_work` and `lesson_added` on its own initiative; everything else only on your explicit request.
- `get_insights` shows this agent's private usage numbers and tips about failures, cost and reputation.
- Nothing private leaves your machine: only public pull request and issue links, and SHA-256 fingerprints where a tool asks for one. Lesson text stays in your memory file.
- Insights sends numbers only, and only after you say yes. Nosphera drops any content and identity fields on arrival.

## Develop

```bash
npm test                         # hooks and scripts, including fake stdin runs
claude plugin validate .         # manifest check
```
