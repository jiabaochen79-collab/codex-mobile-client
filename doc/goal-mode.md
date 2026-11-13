# Native Goal Mode

The mobile composer offers Goal Mode under Add Content. New Task also offers a
Goal Mode checkbox. Enter the objective and completion criteria, then explicitly
send or create the task. Selecting the mode alone starts no work.

The helper submits the native `/goal` command through the existing authenticated,
idempotent message path. Queued objectives are stored by the computer helper;
the browser does not run a continuation loop. Native Codex continues the goal
across assistant turns while the computer and Codex remain running.

The compact goal row reads the real native goal state: active, paused, complete,
blocked, budget limited or usage limited. Expand it to inspect the objective and
pause an active goal or delete the goal. Paused, blocked and usage-limited goals
also show Continue directly in the compact row. Continue restores the original
native goal, retaining its objective, creation time and usage. Budget-limited
goals require a budget adjustment in Codex before continuing. Stopping one
generation is distinct from pausing the goal.
An interrupted turn must not be displayed as a completed or paused goal.

Goal mode and plan mode are separate. Selecting Goal Mode switches the next-turn
mode out of Plan Mode only after the native setting is confirmed. It preserves
drafts, attachments and task permissions. It does not auto-send a draft, resume a
paused goal, restart Codex, or change the goal's token budget.

The feature requires helper 0.4.55 or later and a verified compatible native
goal implementation. Unsupported helpers retain ordinary and plan-mode workflows.
Objective drafts are limited to 4,000 characters. An unfinished goal is not
silently replaced from the mode picker; use the existing conversation to provide
additional instructions.

Continuing and deleting require helper 0.4.63 and the `goal-controls` capability.
The helper locates the exact native goal control after navigating to its task,
then checks authorization, connection epoch and goal revision again before
invoking it. It uses the desktop's existing connection; starting a separate
app-server process would update storage without notifying the desktop. The
computer must be unlocked. A minimized window is temporarily restored without
activation, then returned to its previous state. An unavailable native panel
produces a visible error and does not fall back to a model-generated message.
The result is confirmed from native goal state; uncertain results are never
automatically replayed.

Deleting requires confirmation, clears only the goal, and preserves conversation
history, drafts and any running turn. Continuing requires an active subscription
and no pending questions, running turn or queued messages. Pausing and deleting
are safety operations; they do not grant permission to resume expired service.

Pause requires the control lease and a matching native goal revision. Subscription
expiry does not block this safety operation. An unconfirmed pause is reported as
unknown rather than falsely displaying success. The helper also pauses pending
remote messages after a successful or uncertain goal pause.
