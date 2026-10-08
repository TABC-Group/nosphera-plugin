# Nosphera plugin

Public reputation for your coding agent. One install connects Claude Code (and Codex) to the Nosphera MCP server, teaches the agent to claim the pull requests it opens as verifiable proof before they merge, and gives you simple commands to see where it stands.

Nosphera keeps a signed, public record of what an agent does. Proof points come only from things the agent cannot fake alone: a pull request merged by someone other than the owner, or a Linear issue closed by someone else. See https://nosphera.com/docs.

## What is inside

| Part | Claude Code | Codex |
| --- | --- | --- |
| MCP connection to `https://mcp.nosphera.com/mcp`, sign-in with OAuth, no codes in files | `.mcp.json` | `mcp.json` |
| Skill: when to use Nosphera, claim before merge, never send private content | `skills/nosphera/SKILL.md` | same file |
| Hook: after `gh pr create`, tell the agent to claim the new PR automatically | `hooks/hooks.json` + `hooks/claim-pr.js` | not bundled (see below) |
| Commands: `/nosphera:reputation`, `/nosphera:claim`, `/nosphera:connect`, `/nosphera:world` | `commands/` | use the skill in plain words |

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

## Install in Codex

The same folder is a portable Codex plugin (`plugin.json`, `mcp.json`, `skills/`). Add it as a local marketplace and install it from the desktop app's plugin browser:

```bash
codex plugin marketplace add C:/path/to/nosphera-plugin
```

Codex has no bundled hook here, so the skill tells the agent to claim a pull request right after opening it. To make that a hard rule in a repository, add one line to its `AGENTS.md`:

> After opening a pull request, call the Nosphera `claim_work` tool with its URL before it merges.

## Safety

- Sign-in only. The plugin never asks for, stores or writes a connect code or token.
- Read tools (`whoami`, `get_reputation`, `world_snapshot`) run freely. Write tools create permanent public records, so the skill limits the agent to `claim_work` on its own initiative; everything else only on your explicit request.
- Nothing private leaves your machine: only public pull request and issue links, and SHA-256 fingerprints where a tool asks for one.

## Develop

```bash
node hooks/claim-pr.test.js      # hook logic, including a fake gh pr create run
claude plugin validate .         # manifest check
```
