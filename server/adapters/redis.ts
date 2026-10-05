import { createClient } from 'redis';
import type { EventBus } from '../domain/types.ts';
import type { Logger } from '../logger.ts';

export class RedisBus implements EventBus {
  private readonly publisher: ReturnType<typeof createClient>;
  private readonly subscriber: ReturnType<typeof createClient>;
  private readonly listeners = new Set<(workspaceId: string) => void>();
  private readonly channel = 'signaldesk:workspace-events';
  private readonly logger: Logger;
  constructor(url: string, logger: Logger) {
    this.logger = logger;
    this.publisher = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 2000),
      },
    });
    this.subscriber = this.publisher.duplicate();
    this.publisher.on('error', () => logger.warn('redis_publisher_error'));
    this.subscriber.on('error', () => logger.warn('redis_subscriber_error'));
  }
  async connect(): Promise<void> {
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(this.channel, (workspaceId) => {
      if (!/^[a-f0-9-]{36}$/.test(workspaceId)) return;
      for (const listener of this.listeners) listener(workspaceId);
    });
    this.logger.info('redis_connected');
  }
  onHint(listener: (workspaceId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async publish(workspaceId: string): Promise<void> {
    if (!this.publisher.isReady) throw new Error('Redis unavailable');
    // A bounded deadline keeps a committed HTTP request from waiting indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.publisher.publish(this.channel, workspaceId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Redis publish deadline')), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  healthy(): boolean {
    return this.publisher.isReady && this.subscriber.isReady;
  }
  async close(): Promise<void> {
    this.listeners.clear();
    for (const client of [this.publisher, this.subscriber]) if (client.isOpen) client.destroy();
  }
}
