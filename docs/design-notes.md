# Design notes

Background on why the project is shaped the way it is. For setup and usage, see the README.

## Two separate approval channels

There are two different things a button can approve, and they do not share a mechanism.

1. **The `request_approval` MCP tool.** Claude calls the tool, the call blocks, and a button press on the broker (`POST /approve` or `POST /deny`) resolves it. This is fully under this project's control.
2. **Claude Code's own terminal permission prompt** ("Do you want to proceed?"). The broker cannot answer this. The button has to send a keystroke to the terminal instead.

For the second channel the working approach is a Stream Deck **Multi-Action**: first **System > Open** your terminal application so it has focus, then **System > Hotkey** sending `Return` (or `Escape` to reject). This relies on the Stream Deck app's own Accessibility permission, so make sure **Elgato Stream Deck** is enabled under System Settings > Privacy & Security > Accessibility. If it is missing from that list, the key press does nothing and gives no error.

One approach that does not work: a small AppleScript app built with `osacompile` that sends the keystroke. Its ad-hoc code signature changes on every rebuild, so macOS drops its Accessibility grant each time and the keystroke fails silently. Use the Stream Deck app's own hotkey action instead.

## Final button layout

The Stream Deck Mini has six keys. The layout was picked from how often each action is used in real Claude Code sessions, so the most frequent action sits in the most prominent position.

| | Column 1 | Column 2 | Column 3 |
|---|---|---|---|
| Row 1 | **Stop**: hotkey `Escape` | **Approve**: Multi-Action (open terminal, then `Return`) | **Auto**: hotkey `Shift+Tab` (cycles the permission mode) |
| Row 2 | **Compact**: text `/compact ` | **Handoff**: text `/handoff ` | **Clear**: text `/clear`, no Enter |

Notes on the details:

- **Slash-command keys end with a trailing space.** Stream Deck's automatic Enter can fire before Claude Code's slash-command autocomplete menu has settled, and the wrong command runs. A trailing space closes the menu first, so Enter then submits what you typed.
- **Clear types the command but does not press Enter.** It is destructive, so you confirm it yourself.
- **Handoff is an example.** `/handoff` is a custom command. Replace it with any command you run often.
- Keys that send keystrokes only do something useful when the terminal (or Claude Desktop) has focus. The Approve Multi-Action focuses the terminal itself. The broker's HTTP endpoints work regardless of focus.

## Why a broker

Claude Code starts one MCP server process per session, and every one runs the same code at the same time. The first version had each MCP server bind port 7777 to receive the button press. With several sessions open, one server won the port and the rest failed with `EADDRINUSE`. The button then reached whichever session happened to win the race, not the one you were looking at, and crashed sessions could leave orphaned processes holding the port.

The general rule: **a per-session server cannot own a singleton resource.** Anything exclusive (a port, a socket, a lock file, a device) belongs to a single long-lived process. So the project is split in two:

- A **broker daemon**, managed by launchd, owns `127.0.0.1:7777` and the approval queue.
- Each session's **MCP server is a pure client**. It binds nothing, posts to the broker and long-polls for the answer. If the broker is down it returns a clear error instead of hanging.

The original test suite started one MCP server and passed. The failure only existed with several running at once, which is a useful reminder to test the concurrency model you actually deploy.

## Queue semantics

A physical button cannot choose between requests, so the queue always presents one well-defined target: the oldest pending request (the head). The queue exists to serialise requests from several sessions, not to give the button several targets. `GET /status` shows the head so you can see what a press will act on.

- The outcome is a three-state enum: `approved`, `denied` or `timeout`. A timeout means nobody answered, which is different from a refusal, and the model should treat it that way.
- If a session disconnects while waiting, its request is cancelled so it cannot block the queue.
- Resolved outcomes are kept for 30 seconds so that a button press landing between `/enqueue` and `/wait/:id` is not lost.

## Implementation details worth knowing

- **`node:http`, not `fetch`, for the long-poll.** Node's `fetch` aborts a request whose response headers have not arrived within about five minutes. The `/wait` call can legitimately last up to an hour, so the MCP server uses `http.request`, and the broker sets `requestTimeout` and `headersTimeout` to 0.
- **Timers are `unref()`ed.** Otherwise a pending five-minute approval timeout keeps the process alive after `SIGTERM`.
- **One shutdown path.** The MCP server shuts down on transport close, plus signals. Adding a second handler "for safety" (for example on stdin end) fires in situations you did not model.
- **Every request path writes a response.** Cancelling a request wakes its waiters, and the body-size guard replies with 413 before destroying the socket. Otherwise long-poll responses are stranded and can block shutdown.
- **A single source of truth for the tool schema.** The tool input is defined once with zod. A hand-written JSON Schema alongside a zod validator drifts over time.

## Security notes

The broker listens on loopback only, but "local" is not the same as "trusted":

- Any process on the machine can call `/approve`.
- A web page open in your browser can send a cross-site `POST` to `http://127.0.0.1:7777/approve` without needing to read the response (a "simple" request with no CORS preflight), or can use DNS rebinding to make the browser treat the broker as same-origin.

The broker therefore checks that the `Host` header is `127.0.0.1:<port>` or `localhost:<port>` (defeats DNS rebinding) and rejects any request carrying an `Origin` header (browsers always send one on cross-site `POST`s, while the MCP server and `curl` do not). An optional shared secret, sent in the `x-broker-secret` header, additionally stops other local processes from approving or enqueuing. See the README for what is and is not protected.
