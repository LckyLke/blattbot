import type { WebSocket } from "ws";

const subscribers = new Map<string, Set<WebSocket>>();

export function subscribe(projectId: string, socket: WebSocket): void {
  let set = subscribers.get(projectId);
  if (!set) {
    set = new Set();
    subscribers.set(projectId, set);
  }
  set.add(socket);
  socket.on("close", () => {
    set!.delete(socket);
    if (set!.size === 0) subscribers.delete(projectId);
  });
}

export function broadcast(projectId: string, event: Record<string, unknown>): void {
  const set = subscribers.get(projectId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}
