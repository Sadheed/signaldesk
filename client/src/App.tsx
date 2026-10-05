import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Actor, Activity, EventKind, FeedPage } from '../../server/domain/types.ts';
import { api, ApiError, messageFrom } from './api.ts';
import { mergeActivities } from './feed.ts';

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        S
      </span>
      <span>
        Signal<span className="brand-light">Desk</span>
      </span>
    </div>
  );
}

export function App() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const exit = useCallback(() => setActor(null), []);
  useEffect(() => {
    const controller = new AbortController();
    api<Actor>('/me', 'GET', undefined, controller.signal)
      .then(setActor)
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 401) && !controller.signal.aborted)
          setError('The server could not be reached. Check the connection and reload.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  if (loading)
    return (
      <main className="loading-screen" role="status">
        <Brand />
        <p>Connecting to your workspace...</p>
      </main>
    );
  return actor ? (
    <Dashboard key={actor.id} actor={actor} onExit={exit} />
  ) : (
    <AuthScreen onLogin={setActor} initialError={error} />
  );
}

function AuthScreen({
  onLogin,
  initialError,
}: {
  onLogin: (actor: Actor) => void;
  initialError: string;
}) {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    const body = {
      email: String(data.get('email')),
      password: String(data.get('password')),
      ...(register
        ? { name: String(data.get('name')), workspaceName: String(data.get('workspaceName')) }
        : {}),
    };
    try {
      onLogin(await api<Actor>(register ? '/auth/register' : '/auth/login', 'POST', body));
    } catch (err) {
      setError(messageFrom(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div>
          <p className="eyebrow">A QUIETER WAY TO STAY IN THE LOOP</p>
          <h1>
            Your team.
            <br />
            Every signal.
            <br />
            <span>One place.</span>
          </h1>
          <p className="story-copy">
            Deployments, incidents, and the updates that matter. An activity inbox that keeps the
            whole team on the same page.
          </p>
          <div className="story-preview">
            <span className="dot" />
            <div>
              <strong>Production deployment complete</strong>
              <p>Platform team · just now</p>
            </div>
            <span className="preview-label">LIVE</span>
          </div>
        </div>
        <p className="story-footer">Built for small teams. Designed around reliable delivery.</p>
      </section>
      <main className="auth-form">
        <div>
          <p className="eyebrow">YOUR WORKSPACE AWAITS</p>
          <h2>{register ? 'Start your workspace' : 'Welcome back'}</h2>
          <p className="muted">
            {register
              ? 'Create a team inbox and become its first admin.'
              : 'Sign in to catch up with your team.'}
          </p>
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              {register && (
                <>
                  <label htmlFor="name">Your name</label>
                  <input id="name" name="name" autoComplete="name" required maxLength={80} />
                  <label htmlFor="workspaceName">Workspace name</label>
                  <input
                    id="workspaceName"
                    name="workspaceName"
                    required
                    maxLength={80}
                    placeholder="e.g. Platform team"
                  />
                </>
              )}
              <label htmlFor="email">Email address</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="you@example.com"
              />
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                minLength={register ? 12 : 1}
                maxLength={128}
              />
              {register && (
                <p className="input-hint">
                  Use at least 12 characters. Team members can be added after registration.
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary full" type="submit">
                {busy ? 'Please wait...' : register ? 'Create workspace' : 'Sign in'}
              </button>
            </fieldset>
          </form>
          <p className="auth-switch">
            {register ? 'Already have an account?' : 'New team?'}{' '}
            <button
              className="text-button"
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? 'Sign in' : 'Create a workspace'}
            </button>
          </p>
          <p className="fine-print">
            Members: use the account your workspace admin created for you.
          </p>
        </div>
      </main>
    </div>
  );
}

function Dashboard({ actor, onExit }: { actor: Actor; onExit: () => void }) {
  const [items, setItems] = useState<Activity[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState('Connecting');
  const [filter, setFilter] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [composer, setComposer] = useState(false);
  const [members, setMembers] = useState(false);
  const [pendingReads, setPendingReads] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | undefined;
    api<FeedPage>('/events', 'GET', undefined, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setNextBefore(page.nextBefore);
        stream = new EventSource(`/api/events/stream?after=${page.cursor}`);
        stream.onopen = () => setConnection('Live');
        stream.onerror = () => {
          setConnection('Reconnecting');
          void api<Actor>('/me').catch((err: unknown) => {
            if (err instanceof ApiError && err.status === 401) {
              stream?.close();
              onExit();
            }
          });
        };
        stream.addEventListener('activity', (event: MessageEvent<string>) => {
          try {
            const activity = JSON.parse(event.data) as Activity;
            setItems((previous) => mergeActivities(previous, [activity]));
          } catch {
            setError('An update could not be read. Reload to recover your feed.');
          }
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) onExit();
        else setError(messageFrom(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      stream?.close();
    };
  }, [actor.id, onExit]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMoreBusy(true);
    setError('');
    try {
      const page = await api<FeedPage>(`/events?before=${nextBefore}`);
      setItems((previous) => mergeActivities(previous, page.items));
      setNextBefore(page.nextBefore);
    } catch (err) {
      setError(messageFrom(err));
    } finally {
      setMoreBusy(false);
    }
  };
  const mark = async (item: Activity) => {
    setPendingReads((previous) => new Set(previous).add(item.id));
    try {
      await api(`/events/${item.id}/read`, 'PUT', { read: !item.read });
      setItems((previous) =>
        previous.map((row) => (row.id === item.id ? { ...row, read: !item.read } : row)),
      );
    } catch (err) {
      setError(messageFrom(err));
    } finally {
      setPendingReads((previous) => {
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
    }
  };
  const logout = async () => {
    try {
      await api('/auth/logout', 'POST');
      onExit();
    } catch (err) {
      setError(messageFrom(err));
    }
  };
  const unread = items.filter((item) => !item.read).length;
  const visible = items.filter(
    (item) => (filter === 'all' || item.kind === filter) && (!unreadOnly || !item.read),
  );
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-card">
          <span className="workspace-avatar">{actor.workspaceName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{actor.workspaceName}</strong>
            <span>Your team workspace</span>
          </div>
        </div>
        <nav aria-label="Workspace navigation">
          <button
            className={!members ? 'nav-link active' : 'nav-link'}
            onClick={() => setMembers(false)}
          >
            <span aria-hidden="true">◫</span> Activity inbox <span className="count">{unread}</span>
          </button>
          <button
            className={members ? 'nav-link active' : 'nav-link'}
            onClick={() => setMembers(true)}
          >
            <span aria-hidden="true">♧</span> Team members
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="dot" />
          <p>Live updates, with history that stays.</p>
        </div>
        <div className="profile">
          <span className="avatar">{actor.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{actor.name}</strong>
            <span>{actor.role === 'admin' ? 'Workspace admin' : 'Team member'}</span>
          </div>
          <button aria-label="Sign out" title="Sign out" onClick={logout}>
            ↗
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <span>
            Workspace <span className="breadcrumb">/</span> {members ? 'Team' : 'Activity'}
          </span>
          <span className={`connection ${connection === 'Live' ? 'connected' : ''}`} role="status">
            <span className="dot" />
            {connection}
          </span>
        </header>
        <div className="page-body">
          <div className="page-heading">
            <div>
              <p className="eyebrow">STAY ON THE SAME PAGE</p>
              <h1>{members ? 'Your team' : 'Activity inbox'}</h1>
              <p className="muted">
                {members
                  ? 'The people who share your workspace.'
                  : 'The latest updates from your team, as they happen.'}
              </p>
            </div>
            {actor.role === 'admin' && !members && (
              <button className="primary" onClick={() => setComposer(true)}>
                + Publish update
              </button>
            )}
          </div>
          {error && (
            <div className="error banner" role="alert">
              {error}
              <button className="text-button" onClick={() => setError('')}>
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <div className="notice banner" role="status">
              {notice}
              <button className="text-button" onClick={() => setNotice('')}>
                Dismiss
              </button>
            </div>
          )}
          {members ? (
            <Team actor={actor} onError={setError} />
          ) : (
            <>
              <div className="summary-row">
                <div className="summary-card">
                  <span>Updates loaded</span>
                  <strong>{items.length}</strong>
                </div>
                <div className="summary-card">
                  <span>Unread in loaded feed</span>
                  <strong>{unread}</strong>
                </div>
                <div className="summary-card context-card">
                  <span className="small-label">YOUR TEAM’S PULSE</span>
                  <p>
                    A shared view.
                    <br />
                    <strong>Less catching up.</strong>
                  </p>
                </div>
              </div>
              <div className="feed-toolbar">
                <div className="tabs" aria-label="Filter activity">
                  {['all', 'deployment', 'incident', 'announcement'].map((kind) => (
                    <button
                      key={kind}
                      aria-pressed={filter === kind}
                      className={filter === kind ? 'selected' : ''}
                      onClick={() => setFilter(kind)}
                    >
                      {kind === 'all'
                        ? 'All updates'
                        : `${kind[0]!.toUpperCase()}${kind.slice(1)}s`}
                    </button>
                  ))}
                </div>
                <label className="unread-toggle">
                  <input
                    type="checkbox"
                    checked={unreadOnly}
                    onChange={(event) => setUnreadOnly(event.target.checked)}
                  />
                  Unread only
                </label>
              </div>
              {loading ? (
                <p className="empty" role="status">
                  Loading your activity...
                </p>
              ) : visible.length === 0 ? (
                <div className="empty">
                  <span className="empty-symbol" aria-hidden="true">
                    ◫
                  </span>
                  <h2>
                    {items.length ? 'You’re all caught up here' : 'Your team’s story starts here'}
                  </h2>
                  <p>
                    {items.length
                      ? 'Try another filter to see more updates.'
                      : actor.role === 'admin'
                        ? 'Publish your first update, then open another browser to see it arrive live.'
                        : 'Updates from your workspace admin will appear here.'}
                  </p>
                </div>
              ) : (
                <div className="feed-list">
                  {visible.map((item) => (
                    <article
                      className={`activity-card ${item.read ? 'is-read' : ''}`}
                      key={item.id}
                    >
                      <div className={`kind-icon ${item.kind}`} aria-hidden="true">
                        {item.kind === 'deployment' ? '↗' : item.kind === 'incident' ? '!' : '◎'}
                      </div>
                      <div className="activity-content">
                        <div className="activity-meta">
                          <span className={`kind-label ${item.kind}`}>{item.kind}</span>
                          <time dateTime={item.createdAt}>
                            {new Date(item.createdAt).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                        <h2>
                          {item.title}
                          {!item.read && <span className="unread-dot" aria-label="Unread" />}
                        </h2>
                        <p className="activity-body">{item.body}</p>
                        <div className="activity-footer">
                          <span>
                            <span className="mini-avatar">{item.actorName.slice(0, 1)}</span>
                            {item.actorName}
                          </span>
                          <button
                            className="text-button"
                            disabled={pendingReads.has(item.id)}
                            onClick={() => mark(item)}
                          >
                            {pendingReads.has(item.id)
                              ? 'Saving...'
                              : item.read
                                ? 'Mark unread'
                                : 'Mark read'}
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {nextBefore && items.length < 500 && (
                <button className="secondary load-more" onClick={loadMore} disabled={moreBusy}>
                  {moreBusy ? 'Loading...' : 'Load older updates'}
                </button>
              )}
              <p className="feed-footnote">
                Showing up to 500 loaded updates. Read status is personal to you.
              </p>
            </>
          )}
        </div>
      </main>
      {composer && (
        <Composer
          onClose={() => setComposer(false)}
          onCreated={(event) => {
            setItems((previous) => mergeActivities(previous, [event]));
            setComposer(false);
            setNotice('Your update was published to the workspace.');
          }}
        />
      )}
    </div>
  );
}

function Composer({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (event: Activity) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      onCreated(
        await api<Activity>('/events', 'POST', {
          title: String(data.get('title')),
          body: String(data.get('body')),
          kind: String(data.get('kind')) as EventKind,
        }),
      );
    } catch (err) {
      setError(messageFrom(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="compose-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id="compose-title">Publish an update</h2>
        <button
          className="close-button"
          aria-label="Close update form"
          onClick={onClose}
          disabled={busy}
        >
          ×
        </button>
      </div>
      <p className="muted">Everyone in your workspace can see this update.</p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label htmlFor="kind">Update type</label>
          <select name="kind" id="kind">
            <option value="announcement">Announcement</option>
            <option value="deployment">Deployment</option>
            <option value="incident">Incident</option>
          </select>
          <label htmlFor="title">Title</label>
          <input
            name="title"
            id="title"
            required
            maxLength={120}
            autoFocus
            placeholder="What should your team know?"
          />
          <label htmlFor="body">Details</label>
          <textarea
            name="body"
            id="body"
            required
            maxLength={2000}
            rows={5}
            placeholder="Add the context that matters."
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary">
              {busy ? 'Publishing...' : 'Publish update'}
            </button>
          </div>
        </fieldset>
      </form>
    </dialog>
  );
}

function Team({ actor, onError }: { actor: Actor; onError: (message: string) => void }) {
  const [people, setPeople] = useState<Pick<Actor, 'id' | 'name' | 'email' | 'role'>[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<typeof people>('/members', 'GET', undefined, controller.signal)
      .then(setPeople)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) onError(messageFrom(err));
      });
    return () => controller.abort();
  }, [onError]);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const member = await api<Actor>('/members', 'POST', {
        name: String(data.get('name')),
        email: String(data.get('email')),
        password: String(data.get('password')),
      });
      setPeople((previous) => [...previous, member]);
      form.reset();
    } catch (err) {
      onError(messageFrom(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="team-panel">
      <div className="team-list">
        {people.map((person) => (
          <div className="team-person" key={person.id}>
            <span className="avatar">{person.name.slice(0, 1)}</span>
            <div>
              <strong>{person.name}</strong>
              <span>{person.email}</span>
            </div>
            <span className="role-badge">{person.role}</span>
          </div>
        ))}
      </div>
      {actor.role === 'admin' && (
        <form className="member-form" onSubmit={add}>
          <h2>Add a member</h2>
          <p className="muted">
            Share their initial password privately. Email invitations and password changes are
            future work; use disposable credentials for this portfolio demo.
          </p>
          <fieldset disabled={busy}>
            <label htmlFor="member-name">Name</label>
            <input name="name" id="member-name" required maxLength={80} />
            <label htmlFor="member-email">Email</label>
            <input name="email" id="member-email" type="email" required maxLength={254} />
            <label htmlFor="member-password">Initial password</label>
            <input
              name="password"
              id="member-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
            <button className="primary" type="submit">
              {busy ? 'Adding...' : 'Add team member'}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
