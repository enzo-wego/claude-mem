---
description: "Manually trigger summary for a session without Stop hook"
argument-hint: "[session_id or 'list' to see sessions without summaries]"
---

You are helping the user manually summarize a claude-mem session that didn't receive the automatic Stop hook.

## If argument is 'list' or empty:

Query the database to find sessions that have observations but no summary:

```bash
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT
  s.id as session_id,
  s.content_session_id,
  s.project,
  COUNT(o.id) as obs_count,
  datetime(MAX(o.created_at_epoch)/1000, 'unixepoch', 'localtime') as last_activity
FROM sdk_sessions s
JOIN observations o ON o.memory_session_id = s.memory_session_id
LEFT JOIN session_summaries ss ON ss.memory_session_id = s.memory_session_id
WHERE ss.id IS NULL
GROUP BY s.id
ORDER BY MAX(o.created_at_epoch) DESC
LIMIT 15;
"
```

Display the results and ask the user which session they want to summarize.

## If argument is a session ID (number):

1. **Get session details**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT content_session_id, project FROM sdk_sessions WHERE id = $ARGUMENTS;
"
```

2. **Get the user's original prompt**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT prompt_text FROM user_prompts
WHERE content_session_id = (SELECT content_session_id FROM sdk_sessions WHERE id = $ARGUMENTS)
ORDER BY prompt_number DESC LIMIT 1;
"
```

3. **Get observations for context**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT title, facts FROM observations
WHERE memory_session_id = (SELECT memory_session_id FROM sdk_sessions WHERE id = $ARGUMENTS);
"
```

4. **Based on the observations, construct a reasonable `last_assistant_message`** that describes what was accomplished. Then trigger the summarize:

```bash
curl -X POST http://127.0.0.1:37777/api/sessions/summarize \
  -H "Content-Type: application/json" \
  -d '{
    "contentSessionId": "<content_session_id from step 1>",
    "last_assistant_message": "<constructed summary of what was done based on observations>"
  }'
```

5. **Wait for processing** (about 15 seconds for Gemini) and verify the summary was created:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "
SELECT id, request, next_steps FROM session_summaries
WHERE memory_session_id = (SELECT memory_session_id FROM sdk_sessions WHERE id = $ARGUMENTS);
"
```

6. **Report success** with the generated summary details.

## Notes
- The `last_assistant_message` should summarize what was accomplished based on the observations
- If a session already has a summary, inform the user instead of creating a duplicate
- The worker must be running (check with `curl http://127.0.0.1:37777/health`)
