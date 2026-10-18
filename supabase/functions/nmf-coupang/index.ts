import { createHandler } from "./handler.ts";
import { queue } from "./queue.ts";
Deno.serve(
  createHandler({ env: (key) => (Deno.env.get(key) || "").trim(), queue }),
);
