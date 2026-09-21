import { resolve, sep, extname } from "node:path";
import { createApp } from "./app";
import { secureResponse } from "./security";
export { createApp } from "./app";

if (import.meta.main) {
  const app = createApp();
  const dist = resolve("dist");
  Bun.serve({
    hostname: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
    maxRequestBodySize: 11 * 1024 * 1024,
    async fetch(request, server) {
      const handle = async () => {
        const url = new URL(request.url);
        if (
          url.pathname === "/api" ||
          url.pathname.startsWith("/api/") ||
          ["/healthz", "/readyz"].includes(url.pathname)
        ) {
          return app.fetch(request, {
            remoteAddress: server.requestIP(request)?.address,
          });
        }
        if (!["GET", "HEAD"].includes(request.method))
          return new Response("Not found", { status: 404 });
        let path: string;
        try {
          path = resolve(dist, "." + decodeURIComponent(url.pathname));
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (!path.startsWith(dist + sep) && path !== dist)
          return new Response("Not found", { status: 404 });
        const asset = Bun.file(path);
        const file =
          path !== dist && (await asset.exists())
            ? asset
            : !extname(path)
              ? Bun.file(resolve(dist, "index.html"))
              : null;
        if (!file || !(await file.exists()))
          return new Response("Not found", { status: 404 });
        return new Response(request.method === "HEAD" ? null : file, {
          headers: {
            "Content-Type": file.type,
            "X-Content-Type-Options": "nosniff",
          },
        });
      };
      return secureResponse(await handle());
    },
  });
}
