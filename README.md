# streamdeck-claude

Approve or deny a Claude tool call with a physical Stream Deck button.

When Claude Code needs your permission it stops and waits, and you have to go and find the right window to answer it. This project puts Approve and Deny on a Stream Deck instead, so you answer with one press and carry on with what you were doing. It only runs on macOS.

The tricky part is having more than one Claude session open. If each session listened for the button itself, a press would go to whichever session grabbed the port first. So one background process, the broker, owns the port, and each Claude session runs a small MCP server that does nothing but talk to the broker. Requests from every session wait in a single queue. A press always answers the oldest one still waiting, whichever session it came from, and `/status` shows you which one that is.

The broker runs under launchd. Using it for real needs Stream Deck hardware, but [Demo without hardware](#demo-without-hardware) shows how to try everything except the button with curl.

## What it does

- Claude calls the `request_approval` MCP tool before a risky step. The call blocks until you press Approve or Deny, then returns `approved`, `denied` or `timeout` (after 5 minutes by default).
- A broker daemon on `127.0.0.1:7777` keeps one first-in-first-out queue for all sessions, and a button press resolves the oldest pending request.
- There is a button layout for the six-key Stream Deck Mini. One of its keys answers Claude Code's own permission prompt as well.

## Install

```bash
git clone https://github.com/cla1redonald/streamdeck-claude.git
cd streamdeck-claude
npm ci

# A shared secret is recommended (see Security)
export STREAMDECK_BROKER_SECRET="$(openssl rand -hex 32)"

./scripts/install-broker.sh   # builds, installs the launchd agent, checks it is up
```

Then register the MCP server with Claude Code, putting the path to your clone in place of `<path-to-this-repo>`.

```bash
claude mcp add streamdeck-claude -e STREAMDECK_BROKER_SECRET="$STREAMDECK_BROKER_SECRET" \
  -- node <path-to-this-repo>/dist/index.js
```

Leave out the `-e` part if you did not set a secret. For Claude Desktop, add the same command to `claude_desktop_config.json` under `mcpServers`, with the secret in an `env` block.

Start a fresh Claude session and ask it to call `request_approval` before pushing, deleting or deploying anything. To remove the broker later, run `./scripts/uninstall-broker.sh`.

## Button layout

| | Column 1 | Column 2 | Column 3 |
|---|---|---|---|
| Row 1 | **Stop** sends `Escape` | **Approve** opens the terminal, then sends `Return` (a Multi-Action) | **Auto** sends `Shift+Tab` to cycle the permission mode |
| Row 2 | **Compact** types `/compact ` | **Handoff** types `/handoff ` | **Clear** types `/clear` without pressing Enter |

A photo of the layout is still to come.

- Approve answers Claude Code's own permission prompt. It is a Stream Deck Multi-Action that runs System > Open on your terminal app and then System > Hotkey with `Return`. **Elgato Stream Deck** must be enabled under System Settings > Privacy & Security > Accessibility, or it [fails silently](docs/design-notes.md#two-separate-approval-channels).
- The slash-command keys end with a trailing space. The space closes the autocomplete menu before Enter, so the command you typed is the one that runs.
- Clearing can't be undone, so the Clear key types the command and leaves you to press Enter.
- `/handoff` is a custom command. Swap in whatever you run often.
- None of these keys talk to the broker. To answer `request_approval` calls, add a key that runs `scripts/approve.command`, and another for `scripts/deny.command` if you want one. Both scripts send a `POST` to the broker.

[docs/design-notes.md](docs/design-notes.md) has more detail, including the approaches that didn't work.

## Security

The broker only listens on `127.0.0.1`, so nothing on the network can reach it. Other things on the same machine can, including web pages open in your browser, so the broker makes three checks.

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which stops DNS rebinding.
- Any request with an `Origin` header is rejected with 403. Browsers always send one on cross-site `POST`s, so a web page cannot approve a request. The MCP server, `curl` and the button scripts never send one.
- If `STREAMDECK_BROKER_SECRET` is set, `/enqueue`, `/approve` and `/deny` need it in an `x-broker-secret` header and return 401 without it. `install-broker.sh` stores the secret in the LaunchAgent and in a mode 600 file that the button scripts read. The secret is optional.

Together these keep out web pages and rebinding attacks. With the secret set, they also keep out other local processes, as long as those processes can't read the secret.

There are gaps. With no secret set, any local process can approve. A process running as your user can read the LaunchAgent plist, the secret file or the MCP config, so the secret is no defence against malware running as you. `GET /status` and `GET /wait/:id` stay open. `/status` shows the message of the pending request, and wait ids are UUIDs that can't be guessed. The secret itself travels over plain HTTP on loopback.

Keep the broker bound to loopback, and set a secret. It is optional only so that existing installs keep working.

## Demo without hardware

Run a broker on a spare port and play both parts yourself, the Claude session and the button.

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

If you started the broker with a secret, add `-H "x-broker-secret: $STREAMDECK_BROKER_SECRET"` to the `/enqueue` and `/approve` calls. To see the Origin check at work, add `-H 'Origin: https://example.com'` to any call and it returns 403.

## How it works

```
button → approve.command → POST /approve ───────┐
                                                 ▼
session A ─ MCP server (client) ─ POST /enqueue → ┌────────────────┐
session B ─ MCP server (client) ─ GET /wait/:id → │ BROKER (:7777) │  launchd, KeepAlive
                                                  │ FIFO queue     │
                                                  └────────────────┘
```

- `src/broker-state.ts` holds the queue. Each request has its own timeout, and resolved outcomes are kept for a short while so a press that lands before `/wait` isn't lost.
- `src/broker-server.ts` is the HTTP layer, with the Host, Origin and secret checks. If a `/wait` connection drops, its request is cancelled, so a dead session can't block the queue.
- `src/broker.ts` starts the daemon.
- `src/index.ts` is the MCP server that runs in each session. It binds no port, and if the broker isn't running it returns a clear error.

Some useful commands:

```bash
curl localhost:7777/status
tail -f ~/Library/Logs/streamdeck-broker.log
launchctl kickstart -k gui/$(id -u)/com.streamdeck-claude.broker   # restart
npm test && npm run typecheck && npm run build
```

To change the port, set `STREAMDECK_PORT` for the broker and scripts and `BROKER_URL` for the MCP server.

## Licence

MIT, see [LICENSE](LICENSE).
