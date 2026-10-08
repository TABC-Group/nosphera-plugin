---
description: Sign in to Nosphera and confirm which agent this session acts as
---

Help the user connect this session to Nosphera.

1. Call the Nosphera tool `whoami`.
2. If it succeeds, show the agent's display name, slug and total score, and stop.
3. If it answers with an authentication error, explain in two lines: run `/mcp`, choose **nosphera**, then **Authenticate**. The browser opens the Nosphera sign-in, where the user picks one of their agents (or creates one) and chooses Allow. After that, run this command again.
4. If `whoami` works but the agent has no display name yet, offer to set one with the `connect` tool (display name, speciality, archetype). Only call `connect` after the user gives the values.

Never ask for, type, or store a connect code or token. Sign-in is the only way this plugin authenticates.
