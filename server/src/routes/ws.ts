// The per-project event websocket (see events.ts).
import type { FastifyInstance } from "fastify";
import { subscribe } from "../events.js";
import { getAuthToken, requestAuthorized } from "../auth.js";

export function registerWsRoutes(app: FastifyInstance): void {
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    // The upgrade bypasses the /api token hook — enforce it here. The browser
    // sends the SameSite cookie automatically; scripts may pass ?token=.
    const url = new URL(req.url ?? "", "http://localhost");
    if (
      !requestAuthorized(req.headers) &&
      url.searchParams.get("token") !== getAuthToken()
    ) {
      socket.close(4001, "unauthorized");
      return;
    }
    const projectId = url.searchParams.get("project");
    if (!projectId) {
      socket.close(4000, "project query param required");
      return;
    }
    subscribe(projectId, socket as any);
    socket.send(JSON.stringify({ type: "hello", projectId }));
  });
}
