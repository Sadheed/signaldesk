# SignalDesk demo walkthrough

Run the real application following the README. This is not a mock-data product demo. Use disposable accounts only.

1. Register a workspace admin at the login screen.
2. Open Team members and create a member with an initial demo password.
3. Sign in as the member in a private window or separate browser profile.
4. In the admin inbox, publish one deployment, one incident, and one announcement. Both windows should update without a page refresh. Explain the REST -> PostgreSQL commit -> Redis hint -> SSE catch-up path.
5. Mark a member's event read. Its unread indicator changes only for that user; the admin's read state remains unchanged.
6. Toggle event-type and unread filters. Create enough updates to exercise older-page loading.
7. Disconnect the member browser from the network using browser developer tools. Publish another update, reconnect, and confirm catch-up. The connection indicator should change from Live to Reconnecting and back.
8. In a local Compose environment, stop Redis temporarily with `docker compose stop redis`. Publish an update. It should remain in history and connected clients should receive it through reconciliation, potentially after the configured interval. Readiness should return 503. Restart with `docker compose start redis` and wait for readiness to recover.
9. Log out and confirm protected API access is refused. Avoid displaying cookies or passwords in the recording.

## Screenshots to capture after browser verification

- Desktop inbox with three event types, connection state, and read controls.
- Member view demonstrating that publishing/member-provisioning controls are unavailable.
- Team screen and update composer (omit account passwords).
- Narrow-screen inbox showing readable cards/navigation without horizontal overflow.

No screenshots were captured in the restricted development session. Do not use invented images or a claimed hosted URL as verification evidence.

## Manual quality checks

Try keyboard-only navigation, Escape and focus behavior in the native dialog, empty workspace, expired session, validation errors, failed save, long titles, mobile layout, browser refresh, older-page/live-update overlap, and reconnect duplicates. These are pending until a browser is available.
