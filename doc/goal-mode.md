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
pause an active goal. Stopping one generation is distinct from pausing the goal.
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

Pause requires the control lease and a matching native goal revision. Subscription
expiry does not block this safety operation. An unconfirmed pause is reported as
unknown rather than falsely displaying success. The helper also pauses pending
remote messages after a successful or uncertain goal pause.
