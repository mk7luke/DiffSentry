---
name: Bug report
about: Report something in DiffSentry that isn't working as expected
title: "[Bug] "
labels: bug
assignees: ''
---

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Steps to reproduce the behavior:

1. …
2. …
3. See error

If it's reproducible against a PR/issue, link a sanitized example or paste the
relevant walkthrough/comment output.

## Expected behavior

What you expected DiffSentry to do instead.

## Logs

Paste relevant server logs (set `LOG_LEVEL=debug` for more detail). **Redact any
secrets, tokens, or private code.**

```
<logs here>
```

## Environment

- DiffSentry version / commit:
- How you run it: [ ] `npm start`  [ ] Docker  [ ] other
- AI provider: [ ] anthropic  [ ] openai  [ ] openai-compatible (which backend/model?)
- Node.js version:
- Dashboard enabled (`ENABLE_DASHBOARD`)? [ ] yes  [ ] no

## Additional context

Anything else that might help — relevant `.diffsentry.yaml`, env config (redacted),
screenshots, etc.
