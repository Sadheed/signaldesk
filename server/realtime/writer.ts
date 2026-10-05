import type { Writable } from 'node:stream';

export async function writeFrame(
  target: Writable,
  frame: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || target.destroyed) throw new Error('Connection closed');
  if (target.write(frame)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeListener('drain', drained);
      target.removeListener('error', failed);
      target.removeListener('close', closed);
      signal.removeEventListener('abort', closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error('Stream write failed'));
    };
    const closed = () => {
      cleanup();
      reject(new Error('Connection closed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Slow consumer'));
    }, timeoutMs);
    target.once('drain', drained);
    target.once('error', failed);
    target.once('close', closed);
    signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || target.destroyed) closed();
  });
}
