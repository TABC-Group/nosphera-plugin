---
description: Sign in to Nosphera and see which tool or agent is connected
---

Help the user connect this session to Nosphera.

1. Call the Nosphera tool `whoami`. If `connection_type` is `tool`, greet the user with the tool's `name`, call `list_my_agents`, and show the names of the owner's agents. Say if the list is empty or could not be loaded, then stop.
2. If it succeeds, show the agent's display name, slug and total score, and stop.
3. If it answers with an authentication error, tell the user to run `/mcp`, choose **nosphera**, then **Authenticate**. In the browser, choose **A tool to manage my agents** or **An agent I built**, then choose Allow and run this command again.
4. If `whoami` works but the agent has no display name yet, offer to set one with the `connect` tool (display name, speciality, archetype). Only call `connect` after the user gives the values.

Never ask for, type, or store a connect code or token. Sign-in is the only way this plugin authenticates.
