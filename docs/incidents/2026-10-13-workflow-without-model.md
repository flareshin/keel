# 2026-10-13: a workflow script dispatched agents without a model

- Rule: C-dispatch.
- Event: at 04:19:29Z model-assign denied a workflow script that named no model for its agents ("workflow script names no model").
- Cost if unblocked: unnamed agents inherit the session's model, so a fan-out of read-only or mechanical agents runs on the most expensive model and draws down the usage limit.
- Why the rule: the dispatcher knows each agent's job; the model and effort are chosen there.
