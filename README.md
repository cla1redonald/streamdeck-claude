# streamdeck-claude

Approve or deny a Claude tool call with a physical Stream Deck button.

Claude Code stops and waits whenever it needs your permission, and you have to find the right window to answer. This project puts Approve and Deny on a physical Stream Deck button, so you can stay in what you are doing. It works when several Claude sessions run at once, with every request in a single queue. You can try it without the hardware using curl. It is macOS only.

With several Claude sessions open, the button would reach whichever one started first. A single background broker fixes that by owning the port. Each Claude session runs a small MCP server that is just a client of the broker. One button, one queue, the oldest waiting request first: a press always answers the oldest pending request across all sessions, and `/status` shows which one that is.

The broker runs under launchd, and the real thing needs Stream Deck hardware. See [Demo without hardware](#demo-without-hardware) to try everything except the button.

## What it does

- **`request_approval` MCP tool.** Claude calls it before a risky step. The call blocks until you press Approve or Deny, then returns `approved`, `denied` or `timeout` (default 5 minutes).
- **Broker daemon.** Holds a first-in-first-out queue across all sessions on `127.0.0.1:7777`. A button press resolves the oldest pending request.
- **Button layout** for the six-key Stream Deck Mini, including a key that answers Claude Code's own native permission prompt.

## Install

```bash
git clone https://github.com/cla1redonald/streamdeck-claude.git
cd streamdeck-claude
npm ci

# Recommended: a shared secret (see Security)
export STREAMDECK_BROKER_SECRET="$(openssl rand -hex 32)"

./scripts/install-broker.sh   # builds, installs the launchd agent, checks it is up
```

Then register the MCP server with Claude Code, replacing `<path-to-this-repo>` with the clone location:

```bash
claude mcp add streamdeck-claude -e STREAMDECK_BROKER_SECRET="$STREAMDECK_BROKER_SECRET" \
  -- node <path-to-this-repo>/dist/index.js
```

Leave out the `-e` part if you did not set a secret. For Claude Desktop, add the same command to `claude_desktop_config.json` under `mcpServers`, with the secret in an `env` block.

Start a fresh Claude session and ask it to call `request_approval` before pushing, deleting or deploying anything. Remove the broker with `./scripts/uninstall-broker.sh`.

## Button layout

| | Column 1 | Column 2 | Column 3 |
|---|---|---|---|
| Row 1 | **Stop**: `Escape` | **Approve**: Multi-Action, open terminal then `Return` | **Auto**: `Shift+Tab` (cycle permission mode) |
| Row 2 | **Compact**: types `/compact ` | **Handoff**: types `/handoff ` | **Clear**: types `/clear`, no Enter |

Photo of the layout to follow

- **Approve** answers Claude Code's native permission prompt. It is a Stream Deck Multi-Action: System > Open your terminal app, then System > Hotkey `Return`. Enable **Elgato Stream Deck** under System Settings > Privacy & Security > Accessibility or it [fails silently](docs/design-notes.md#two-separate-approval-channels).
- Slash-command keys end with a **trailing space** so the autocomplete menu closes before Enter and the right command runs.
- **Clear** is destructive, so it types the command and waits for you to press Enter.
- `/handoff` is a custom command. Swap in whatever you run often.
- To resolve `request_approval` calls instead, add a key that runs `scripts/approve.command` (and optionally `scripts/deny.command`). They `POST` to the broker.

More detail, including what does not work, is in [docs/design-notes.md](docs/design-notes.md).

## Security

The broker listens on `127.0.0.1` only. It is never reachable from the network, but local does not mean trusted, so it adds three checks:

- **Host check.** `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. This stops DNS rebinding.
- **Origin check.** Any request carrying an `Origin` header is rejected with 403. Browsers always send one on cross-site `POST`s, so a web page cannot approve a request. The MCP server, `curl` and the button scripts send none.
- **Optional shared secret.** If `STREAMDECK_BROKER_SECRET` is set, `/enqueue`, `/approve` and `/deny` need it in an `x-broker-secret` header, or they return 401. `install-broker.sh` stores it in the LaunchAgent and in a mode 600 file that the button scripts read.

What this protects against: web pages, rebinding attacks and (with the secret) other local processes that cannot read your secret.

What it does not: with no secret set, any local process can approve. A process running as your user can read the LaunchAgent plist, the secret file or the MCP config, so the secret does not defend against malware running as you. `GET /status` and `GET /wait/:id` stay open; `/status` shows the pending request message, and wait ids are unguessable UUIDs. The secret travels over plain loopback HTTP.

Keep the broker bound to loopback. The default works without a secret so existing installs keep working, but set one.

## Demo without hardware

Run a broker on a spare port and play both roles yourself:

```bash
npm ci && npm run build
STREAMDECK_PORT=7799 node dist/broker.js &

# 1. A "session" asks for approval
ID=$(curl -s -X POST localhost:7799/enqueue \
  -H 'Content-Type: application/json' \
  -d '{"message":"Push to main?","timeoutMs":60000}' | sed 's/.*"id":"\([^"]*\)".*/\1/')

# 2. See what a button press would act on
curl -s localhost:7799/status

# 3. Wait for the answer in the background, then press "Approve"
curl -s localhost:7799/wait/$ID &
curl -s -X POST localhost:7799/approve    # the waiting curl prints {"outcome":"approved",...}

kill %1 2>/dev/null   # stop the broker
```

If you started the broker with a secret, add `-H "x-broker-secret: $STREAMDECK_BROKER_SECRET"` to the `/enqueue` and `/approve` calls. Adding `-H 'Origin: https://example.com'` to any call returns 403.

## How it works

```
button → approve.command → POST /approve ───────┐
                                                 ▼
session A ─ MCP server (client) ─ POST /enqueue → ┌────────────────┐
session B ─ MCP server (client) ─ GET /wait/:id → │ BROKER (:7777) │  launchd, KeepAlive
                                                  │ FIFO queue     │
                                                  └────────────────┘
```

- `src/broker-state.ts`: the queue. Per-request timeout, and a short retention of resolved outcomes so a press that lands before `/wait` is not lost.
- `src/broker-server.ts`: HTTP layer with the Host, Origin and secret checks. A dropped `/wait` connection cancels its request so a dead session cannot block the queue.
- `src/broker.ts`: daemon entry point.
- `src/index.ts`: per-session MCP server. It binds no port and returns a clear error if the broker is not running.

Useful commands:

```bash
curl localhost:7777/status
tail -f ~/Library/Logs/streamdeck-broker.log
launchctl kickstart -k gui/$(id -u)/com.streamdeck-claude.broker   # restart
npm test && npm run typecheck && npm run build
```

Set `STREAMDECK_PORT` to change the port for the broker and scripts, and `BROKER_URL` for the MCP server.

## Licence

MIT, see [LICENSE](LICENSE).
