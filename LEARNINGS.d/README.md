# LEARNINGS.d — per-session learnings log

Each Claude Code session appends distilled Finding/Shift/Watch entries to its **own** file,
`LEARNINGS.d/<session-id>.md`, created on first write. Never edit another session's file — that is
the concurrent-write race these per-session files exist to avoid.

The `Stop` hook in `.claude/settings.json` prompts a capture once the transcript has grown ≥150KB
and ≥30min have passed since the last fire. The primary capture is Claude appending at session end.

Entry shape (keep it terse):

```
## <date> — <session-id>
- **Finding:** <what we learned that wasn't obvious>
- **Shift:** <what changed in how we work / what to trust>
- **Watch:** <open risk to verify next time>
```
