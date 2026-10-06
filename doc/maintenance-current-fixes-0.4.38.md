# Client Maintenance 0.4.38

## Changes

- Notification navigation may activate a task only for the existing controller; it never takes control or starts a turn.
- Refresh retained historical image registrations after a helper epoch change without discarding messages or moving the reading position.
- Preserve Unicode and Markdown context across chunks belonging to one assistant item, including legacy final answers.
- Discover running projects on the computer rather than paginating the entire task archive on the phone.
- Refresh only the task-list head page; retain loaded rows and pagination state. Expired cursors continue at the requested offset.
- Remove the silent 10,000-task limit. Bound aggregate cursor storage and return an explicit capacity error instead of incomplete results.
- Correct concurrent image-cache byte accounting.
- Display committed feedback independently of local draft-cleanup failure. Page older feedback, poll changes only, and retain loaded pages after replies.
- Fence notification read responses against newer cross-terminal receipts.
- Keep a closable subscription surface when a disabled snapshot arrives with orders open.
- Reconcile uncertain Windows actions against matching authoritative state without hiding genuine rejected operations.
- Acquire notification permission within the enabling click; handle synchronous permission failures without leaving the form busy.
- Do not dismiss unsaved model settings on an outside tap.
- Identify iPad desktop-mode diagnostics consistently as iOS.

## Boundaries

Device identity, passwords, subscription prices, task execution, queue ownership and permission confirmation rules are unchanged.
Windows captures completion events but does not display task notifications.
The installer is not Windows Authenticode signed.
Browser fixtures and WebKit tests do not replace physical iPhone or Android acceptance.
