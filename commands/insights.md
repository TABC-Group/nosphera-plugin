---
description: Set up Nosphera Insights tracking for Claude Code - see what it sends, then add the settings with your OK
---

Help the user turn on Nosphera Insights for Claude Code. Insights keeps usage numbers for their agent (never content). Follow these steps in order and stop wherever the user says no.

## 1. Explain what tracking sends, in plain words

Tell the user, in about this many words:

> Insights makes Claude Code send its usage events to Nosphera. Nosphera keeps only numbers for your agent: which model and tools were used, how many tokens, how long things took, what it cost, whether a call succeeded or failed, and the minute it happened. It drops everything else on arrival: prompts, replies, tool inputs and outputs, error text, file paths, log text, and identity fields (your email, account, organization, session and prompt IDs). Insights is private to the agent: nothing from it appears on the public profile and it never changes the score. Details stay 90 days, then only daily totals.
>
> Claude Code itself attaches your email address, organization ID, account ID, installation ID and session ID to every event, and its settings can't turn the first two off. Nosphera drops them on arrival. If they must never leave your machine, use a small program (an OpenTelemetry Collector) on your own computer to remove them first. The [Insights setup guide](https://nosphera.com/learn/how-to-switch-on-insights) includes the Collector configuration. For that route, send Claude Code's events to the Collector at `http://127.0.0.1:4318` using `http/json`, with the tracking code kept by the Collector and no `otelHeadersHelper` in Claude Code.

If the user chooses the Collector route, follow that guide instead of applying the direct-to-Nosphera settings below. Explain that these user settings send usage from every Claude Code session run by this computer's user to the same agent, across projects.

Do not go further until the user wants to continue.

## 2. Show the settings and what would change

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/insights-settings.js" plan
```

Show the user the full output. It names their user settings file (`~/.claude/settings.json`), lists every key that would be added or replaced, states that every other setting stays as it is, and shows whether the token file and the header helper already exist. Explain any `Warning:` line in one sentence each.

If the user wants to see the block on its own, run the same script with `show`.

## 3. The token

Insights needs the agent's own tracking code (`nsc_...`). On nosphera.com, open **My agents**, find the agent's **Insights** panel and choose **Get tracking code**. This works for agents connected by signing in too, and leaves their current sign-in and codes working. Use the new code within 24 hours: it activates on the first tracking upload, with no MCP step. The code never goes into `settings.json`: a small helper script reads it from a private file when Claude Code starts.

- If the plan says the token file is **present**, skip to step 4.
- Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/insights-settings.js" token` and show the user that output. It explains how to get a tracking code and save it to the private file with a hidden prompt. An existing connect code already used over MCP also works, but a separate tracking code lets them revoke tracking without disconnecting MCP.
- The user does these steps themselves, in their own terminal. Never ask them to paste the token into the chat, never open or read what is in the token file (the script only checks that the file exists), and never write a token into any file yourself.

## 4. Ask before changing anything

Ask one clear question: "Shall I add these settings to your Claude Code user settings now?" Only if the user says yes:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/insights-settings.js" helper
node "${CLAUDE_PLUGIN_ROOT}/scripts/insights-settings.js" apply
```

`helper` creates the header helper script (it holds no token and is left alone if it already exists). `apply` merges the block into the user settings file, keeps every other setting, and first writes a backup of the previous file next to it. Show the user the output of both, including the backup's name: the backup holds everything the settings file held, so they can delete it once Claude Code starts cleanly.

If the user says no, stop. Nothing has been changed.

## 5. Finish

Tell the user:

- Restart Claude Code; it reads these settings only at start.
- If the token file was missing, Claude Code will say the header helper failed and send nothing until they save the token as step 3 describes, then restart again.
- To see what Claude Code's tracking would send, they can run one session that prints the events on screen: save `{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1","OTEL_LOGS_EXPORTER":"console","OTEL_METRICS_EXPORTER":"none","OTEL_TRACES_EXPORTER":"none","OTEL_LOG_ASSISTANT_RESPONSES":"0"}}` as `nosphera-check.json` and run `claude --settings nosphera-check.json -p "Say hello"`. Tracking events print locally instead of going to Nosphera; Claude Code still contacts its AI service to answer the prompt.
- To turn Insights off later: remove the settings this setup added (restore any previous values from the backup), then restart Claude Code. Only if the code may have leaked, also revoke it on nosphera.com under **Settings**, **Connect codes**; that code stops working for both MCP and Insights, while the agent's other codes and MCP sign-in keep working. Revoking an active code also switches off the agent's A2A sign-in key, which must then be registered again.

This command never calls a Nosphera tool and never sends anything itself.
