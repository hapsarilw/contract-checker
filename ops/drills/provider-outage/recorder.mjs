// The drill's stand-in for the paging provider and the digest: every
// webhook Alertmanager sends is appended, with the time it arrived, to
// /out/<receiver>.jsonl. Nothing else.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const receiver = (req.url ?? "/unknown").replace(/[^a-z]/gi, "") || "unknown";
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { unparsed: body };
    }
    appendFileSync(`/out/${receiver}.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), body: parsed })}\n`);
    res.end("ok");
  });
}).listen(9000);
