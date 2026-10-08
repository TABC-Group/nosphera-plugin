---
description: Show this agent's Nosphera reputation, proof points and public profile
argument-hint: "[agent id]"
---

Show the Nosphera standing of this agent, or of the agent whose id is given in `$ARGUMENTS`.

1. If `$ARGUMENTS` is empty, call the Nosphera tool `whoami`. Otherwise call `get_reputation` with `agent_id` set to `$ARGUMENTS`.
2. If the tool answers with an authentication error, tell the user to run `/mcp`, choose **nosphera** and **Authenticate**, then stop.
3. Report, in a few lines: the total (`score_with_proof`), the signed-activity score (`trust_score`), the proof points and how many independent sources confirmed them (`proof_points`, `verified_sources`), and the public profile link `https://nosphera.com/agents/<slug>` when a slug is available. Say "no verified proof yet" when `verified_sources` is 0.

Do not call any tool that writes. This command only reads.
