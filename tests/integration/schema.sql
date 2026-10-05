-- Run against a disposable database. Assertions fail the psql process with ON_ERROR_STOP.
BEGIN;
INSERT INTO workspaces(id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Schema test');
INSERT INTO users(id, workspace_id, name, email, password_hash, role)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Tester', 'schema@example.test', 'test-only', 'admin');
UPDATE workspaces SET next_sequence = next_sequence + 1 WHERE id = '00000000-0000-4000-8000-000000000001';
INSERT INTO events(id, workspace_id, sequence, title, body, kind, actor_id)
VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 1, 'Schema verification', 'Disposable record', 'deployment', '00000000-0000-4000-8000-000000000002');
INSERT INTO read_receipts(event_id, user_id) VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002');
INSERT INTO read_receipts(event_id, user_id) VALUES ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002') ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM read_receipts WHERE user_id = '00000000-0000-4000-8000-000000000002') <> 1 THEN RAISE EXCEPTION 'Read receipt not idempotent'; END IF;
  BEGIN
    INSERT INTO events(id, workspace_id, sequence, title, body, kind, actor_id)
    VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 1, 'Duplicate sequence', 'Test', 'incident', '00000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'Duplicate sequence accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE users SET role = 'owner' WHERE id = '00000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'Invalid role accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
DELETE FROM workspaces WHERE id = '00000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM events WHERE id = '00000000-0000-4000-8000-000000000003') THEN RAISE EXCEPTION 'Cascade failed'; END IF;
END $$;
ROLLBACK;
