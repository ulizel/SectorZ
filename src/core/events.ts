/** Tiny typed event bus. Game events are also what a future co-op host would replicate. */
export type GameEvents = {
  shot: { x: number; y: number; z: number; dx: number; dz: number; weapon: string };
  hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number; dynamic: boolean };
  reloadStart: { weapon: string; time: number };
  reloadEnd: { weapon: string };
  dryFire: { weapon: string };
};

type Handler<T> = (e: T) => void;

export class EventBus<E extends Record<string, unknown> = GameEvents> {
  private handlers: { [K in keyof E]?: Handler<E[K]>[] } = {};

  on<K extends keyof E>(type: K, h: Handler<E[K]>): () => void {
    (this.handlers[type] ??= []).push(h);
    return () => {
      const list = this.handlers[type];
      if (list) list.splice(list.indexOf(h), 1);
    };
  }

  emit<K extends keyof E>(type: K, e: E[K]): void {
    const list = this.handlers[type];
    if (list) for (const h of list) h(e);
  }
}
