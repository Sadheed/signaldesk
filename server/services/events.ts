import type { Actor, Activity, EventBus, EventInput, Store } from '../domain/types.ts';
import { requireAdmin } from '../domain/errors.ts';
import type { Logger } from '../logger.ts';

export class EventService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly logger: Logger;
  constructor(store: Store, bus: EventBus, logger: Logger) {
    this.store = store;
    this.bus = bus;
    this.logger = logger;
  }
  async create(actor: Actor, input: EventInput): Promise<Activity> {
    requireAdmin(actor.role);
    const event = await this.store.createEvent(actor, input);
    try {
      await this.bus.publish(actor.workspaceId);
    } catch {
      this.logger.warn('event_hint_failed', { eventId: event.id, workspaceId: actor.workspaceId });
    }
    return event;
  }
}
