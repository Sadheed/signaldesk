import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Actor, EventBus, Store } from '../domain/types.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { AuthService } from '../services/auth.ts';
import { AppError } from '../domain/errors.ts';
import { writeFrame } from './writer.ts';

interface Client {
  id: string;
  actor: Actor;
  token: string;
  cursor: string;
  response: Response;
  controller: AbortController;
  timer: ReturnType<typeof setInterval>;
  running: boolean;
  requested: boolean;
}

export class SseHub {
  private readonly clients = new Map<string, Client>();
  private readonly store: Store;
  private readonly auth: AuthService;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly unsubscribe: () => void;
  private shuttingDown = false;
  constructor(store: Store, bus: EventBus, config: Config, logger: Logger) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.auth = new AuthService(store, config.SESSION_TTL_HOURS);
    this.unsubscribe = bus.onHint((workspaceId) => {
      for (const client of this.clients.values())
        if (client.actor.workspaceId === workspaceId) this.wake(client);
    });
  }
  get size(): number {
    return this.clients.size;
  }
  open(_request: Request, response: Response, actor: Actor, token: string, cursor: string): void {
    if (this.shuttingDown) throw new AppError(503, 'SHUTTING_DOWN', 'Server shutting down');
    const count = [...this.clients.values()].filter(
      (client) => client.actor.id === actor.id,
    ).length;
    if (
      this.clients.size >= this.config.SSE_MAX_CONNECTIONS ||
      count >= this.config.SSE_MAX_PER_USER
    )
      throw new AppError(429, 'STREAM_LIMIT', 'Too many live connections');
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const id = randomUUID();
    const client: Client = {
      id,
      actor,
      token,
      cursor,
      response,
      controller: new AbortController(),
      timer: setInterval(() => this.wake(client), this.config.SSE_RECONCILE_MS),
      running: false,
      requested: false,
    };
    client.timer.unref();
    this.clients.set(id, client);
    response.once('close', () => this.disconnect(client));
    this.logger.info('stream_open', { userId: actor.id, active: this.size });
    this.wake(client);
  }
  private disconnect(client: Client): void {
    if (!this.clients.delete(client.id)) return;
    clearInterval(client.timer);
    client.controller.abort();
    client.response.end();
    this.logger.info('stream_close', { userId: client.actor.id, active: this.size });
  }
  private wake(client: Client): void {
    if (!this.clients.has(client.id)) return;
    client.requested = true;
    if (!client.running) void this.pump(client);
  }
  private async pump(client: Client): Promise<void> {
    client.running = true;
    try {
      while (client.requested && !client.controller.signal.aborted) {
        client.requested = false;
        // Revoked/expired sessions stop existing streams, not only future REST requests.
        const current = await this.auth.authenticate(client.token);
        if (current.workspaceId !== client.actor.workspaceId) throw new Error('Workspace changed');
        let more = true;
        while (more && !client.controller.signal.aborted) {
          await this.auth.authenticate(client.token);
          const rows = await this.store.after(current, client.cursor, 50);
          for (const event of rows) {
            await writeFrame(
              client.response,
              `id: ${event.sequence}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`,
              this.config.SSE_DRAIN_TIMEOUT_MS,
              client.controller.signal,
            );
            client.cursor = event.sequence;
          }
          more = rows.length === 50;
        }
        await writeFrame(
          client.response,
          ': keepalive\n\n',
          this.config.SSE_DRAIN_TIMEOUT_MS,
          client.controller.signal,
        );
      }
    } catch {
      if (!client.controller.signal.aborted)
        this.logger.warn('stream_interrupted', { userId: client.actor.id });
      this.disconnect(client);
    } finally {
      client.running = false;
    }
  }
  close(): void {
    this.shuttingDown = true;
    this.unsubscribe();
    for (const client of [...this.clients.values()]) this.disconnect(client);
  }
}
