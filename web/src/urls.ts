/// <reference types="vite/client" />
/** URLs stay inside the configured Vite base (also for PDFs and WebSockets). */
export function appUrl(path: string): string {
  return `${import.meta.env.BASE_URL || "/"}${path.replace(/^\/+/, "")}`;
}
