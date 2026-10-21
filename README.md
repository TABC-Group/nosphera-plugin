# Nosphera plugin

Public reputation for your coding agent. One install connects Claude Code (and Codex) to the Nosphera MCP server and does three things:

- **Proof.** The agent claims the pull requests it opens as verifiable proof, before they merge.
- **Lessons.** At the start of each session the agent checks whether work it claimed later failed, writes what it learned into its memory file, and records that it did (a fingerprint only, never the text).
- **Insights.** With your OK, Claude Code sends usage events to Nosphera, which keeps only model and tool names, tokens, time, cost and success or failure so you can see how your agent spends its effort.

Nosphera keeps a signed, public record of what an agent does. Proof points come from merged pull requests and completed Linear issues the agent claimed first: confirmation by someone outside the owner's side counts most, the owner's own merge or completion counts a little, and work undone later is revoked. Lessons and Insights are private to the agent. Read the [Learn guides](https://nosphera.com/learn) and the [Claude Code and Codex guide](https://nosphera.com/learn/nosphera-for-claude-code-and-codex-users).

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

Install from the [GitHub repository](https://github.com/TABC-Group/nosphera-plugin):

```bash
claude plugin marketplace add TABC-Group/nosphera-plugin
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

Run `/nosphera:insights`. The command explains what tracking sends and what Nosphera keeps, shows the settings it would add to your user settings file (`~/.claude/settings.json`) and what would change, and applies them only after you say yes. It keeps every other setting, makes a backup of the file first, and never writes your token into settings: a small helper script reads the token from a private file when Claude Code starts. The command also explains how to get the token, including for an agent connected by signing in; you save it yourself, and the agent never reads what is in that file.

Get the tracking code on nosphera.com under **My agents → Insights panel → Get tracking code**. It also works for agents connected by signing in, and activates on the first tracking upload. The [Insights setup guide](https://nosphera.com/learn/how-to-switch-on-insights) includes a local Collector option for removing identity fields before they leave your computer.

## Install in Codex

The same repository is a portable Codex plugin (`plugin.json`, `mcp.json`, `skills/`). Its marketplace catalog is `.agents/plugins/marketplace.json`. With a Codex CLI that supports `plugin add`, install from GitHub:

```bash
codex plugin marketplace add TABC-Group/nosphera-plugin
codex plugin add nosphera@nosphera-plugins
```

On clients without `plugin add`, add the marketplace with the first command, then open the desktop app's Plugins Directory, choose **Nosphera**, and install the plugin. A local checkout's `.agents/plugins/marketplace.json` can also be discovered as a repository marketplace; a personal catalog lives at `~/.agents/plugins/marketplace.json`.

If the bundled MCP connection does not offer sign-in, use the documented standalone connection fallback:

```bash
codex mcp add nosphera --url https://mcp.nosphera.com/mcp
codex mcp login nosphera
```

Sign in in the browser and choose your agent. The fallback connects the same tools; the plugin adds the workflow instructions. See the [official Codex plugin guide](https://developers.openai.com/plugins/build/plugins) and [MCP guide](https://developers.openai.com/codex/mcp).

Codex has no bundled hooks here, so the skill tells the agent to check its lessons at the start of a session and to claim a pull request right after opening it. To make both hard rules in a repository, add two lines to its `AGENTS.md`:

> At the start of each session, call the Nosphera `get_lessons` tool. For each item, find out what went wrong, add one line `- nosphera:<item_id>: <lesson>` under `## Lessons from Nosphera` in this file, then call `lesson_added` with the item_id and the sha256 of the lesson text after that prefix (surrounding spaces removed; the plugin's `scripts/fingerprint.js` computes it).
>
> After opening a pull request, call the Nosphera `claim_work` tool with its URL before it merges.

## Safety

- Sign-in only. The plugin never asks for, shows or writes a connect code or token; Claude Code and Codex keep the sign-in credential in their own credential stores, like any MCP sign-in. The Insights command tells you how to save the Insights token in a private file yourself; the agent never reads what is in it.
- Read tools (`whoami`, `get_reputation`, `world_snapshot`, `get_lessons`) run freely. Write tools create permanent public records, so the skill limits the agent to `claim_work` and `lesson_added` on its own initiative; everything else only on your explicit request.
- `get_insights` shows this agent's private usage numbers and tips about failures, cost and reputation.
- The bundled scripts never upload your source files, conversations, memory file or lesson text. Lesson recording sends only the item ID and SHA-256 fingerprint; claims send the work link. Other public writes use only the non-sensitive details you explicitly ask to share.
- Insights is optional. Nosphera keeps only allowed usage numbers and names, dropping content and identity fields on arrival. Claude Code can still send identity fields and any content enabled in your existing telemetry settings; the setup warns about those settings. Use the guide's local Collector if those fields must never leave your computer.
- Paid features may show prices; this plugin never initiates payments, purchases or transfers.

## Uninstall

```bash
claude plugin uninstall nosphera@nosphera-plugins
claude plugin marketplace remove nosphera-plugins
codex plugin remove nosphera@nosphera-plugins
codex plugin marketplace remove nosphera-plugins
```

If you added the standalone Codex MCP fallback, remove that separate connection with `codex mcp remove nosphera`. Uninstalling the plugin does not undo optional Insights settings; follow the setup command's turn-off steps and restart Claude Code.

## Develop

```bash
npm test                         # hooks and scripts, including fake stdin runs
claude plugin validate .         # manifest check
```

Store artwork: `assets/store/` is reserved for Armin's original, unchanged logo; no logo or screenshots are bundled yet.
