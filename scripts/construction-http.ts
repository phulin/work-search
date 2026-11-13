import { request, Agent } from "node:https";
/** Separate HTTP/1 connections allow concurrent construction invocations without
 * funneling the whole dispatcher through one multiplexed client connection. */
export function constructionHTTP(concurrency: number) {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency });
  return (url: string, token: string, body: string) =>
    new Promise<{ status: number; ok: boolean; text(): Promise<string> }>(
      (ok, no) => {
        const r = request(
          url,
          {
            method: "POST",
            agent,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const parts: Buffer[] = [];
            response.on("data", (b) => parts.push(b));
            response.once("error", no);
            response.once("end", () => {
              const text = Buffer.concat(parts).toString(),
                status = response.statusCode ?? 0;
              ok({
                status,
                ok: status >= 200 && status < 300,
                text: async () => text,
              });
            });
          },
        );
        r.setTimeout(240000, () =>
          r.destroy(Error("Construction request timeout")),
        );
        r.once("error", no);
        r.end(body);
      },
    );
}
