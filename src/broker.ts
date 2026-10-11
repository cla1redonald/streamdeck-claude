#!/usr/bin/env node
import { BrokerState } from "./broker-state.js";
import { createBrokerServer } from "./broker-server.js";

function main(): void {
  const port = Number(process.env.STREAMDECK_PORT ?? 7777);
  const state = new BrokerState();
  const secret = process.env.STREAMDECK_BROKER_SECRET || undefined;
  const server = createBrokerServer(state, { port, host: "127.0.0.1", secret });

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("listening", () => {
    const auth = secret ? "shared secret required" : "no shared secret set";
    process.stderr.write(`streamdeck-broker listening on http://127.0.0.1:${port} (${auth})\n`);
  });
}

main();
