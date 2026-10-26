# Design notes

Why the project is built the way it is. For setup and day-to-day use, see the README.

## Two separate approval channels

A button can approve two different things, and they work in completely different ways.

1. The `request_approval` MCP tool. Claude calls it, and the call blocks until a button press reaches the broker (`POST /approve` or `POST /deny`). This project controls every step of that.
2. Claude Code's own permission prompt in the terminal ("Do you want to proceed?"). The broker has no way to answer it, so the button has to send a keystroke to the terminal instead.

For the terminal prompt, what works is a Stream Deck **Multi-Action**. Its first step is **System > Open** on your terminal application, which gives the terminal focus. Its second is **System > Hotkey** sending `Return`, or `Escape` to reject. The whole thing relies on the Stream Deck app's own Accessibility permission, so check that **Elgato Stream Deck** is enabled under System Settings > Privacy & Security > Accessibility. If it is missing from that list, the key press does nothing and shows no error.

A small AppleScript app built with `osacompile` to send the keystroke does not work. Its ad-hoc code signature changes every time it is rebuilt, so macOS drops its Accessibility grant each time and the keystroke fails without any error. Use the Stream Deck app's own hotkey action instead.

## Final button layout

The Stream Deck Mini has six keys. They are laid out by how often each action comes up in real Claude Code sessions, with the most frequent one in the most prominent spot.

| | Column 1 | Column 2 | Column 3 |
|---|---|---|---|
| Row 1 | **Stop** is a hotkey for `Escape` | **Approve** is a Multi-Action that opens the terminal, then sends `Return` | **Auto** is a hotkey for `Shift+Tab`, which cycles the permission mode |
| Row 2 | **Compact** types the text `/compact ` | **Handoff** types the text `/handoff ` | **Clear** types the text `/clear` without pressing Enter |

A few of these need explaining.

- The slash-command keys end with a trailing space. Stream Deck's automatic Enter can fire before Claude Code's autocomplete menu has settled, and then the wrong command runs. The space closes the menu first, so Enter submits what you typed.
- Clear types the command but doesn't press Enter. Clearing can't be undone, so you confirm it yourself.
- `/handoff` is a custom command and only an example. Put any command you run often in its place.
- Keys that send keystrokes only help when the terminal, or Claude Desktop, has focus. The Approve Multi-Action gives the terminal focus itself, and the broker's HTTP endpoints work whatever has focus.

## Why a broker

Claude Code starts one MCP server process for each session, and they all run the same code at the same time. In the first version, each MCP server bound port 7777 to hear the button press. With several sessions open, one server got the port and the rest failed with `EADDRINUSE`. The button then reached whichever session happened to win that race, which was often not the one you were looking at, and sessions that crashed could leave orphaned processes holding the port.

A server that starts with each session can't own something only one process can hold at a time, whether that is a port, a socket, a lock file or a device. That has to belong to a single long-lived process. So the project is split in two.

- A broker daemon, run by launchd, owns `127.0.0.1:7777` and the approval queue.
- Each session's MCP server is only a client. It binds nothing, posts to the broker and long-polls for the answer, and if the broker is down it returns a clear error instead of hanging.

The original test suite started a single MCP server, and it passed. The bug only appeared with several servers running at once, which is how the project is really used, so that is the case the tests have to cover.

## Queue semantics

A physical button can't choose between requests, so a press always acts on the oldest request still pending, the head of the queue. The queue is there to put requests from several sessions in order, one behind another. It never offers the button a choice. `GET /status` shows the head, so you can check what a press will act on.

- Every request ends as `approved`, `denied` or `timeout`. A timeout means nobody answered, and the model should treat that differently from a refusal.
- If a session disconnects while waiting, its request is cancelled so it cannot block the queue.
- Resolved outcomes are kept for 30 seconds so that a button press landing between `/enqueue` and `/wait/:id` is not lost.

## Implementation details worth knowing

- The long-poll uses `node:http` rather than `fetch`. Node's `fetch` gives up on a request if the response headers haven't arrived within about five minutes, and a `/wait` call can legitimately last up to an hour. So the MCP server uses `http.request`, and the broker sets `requestTimeout` and `headersTimeout` to 0.
- Timers are `unref()`ed, because otherwise a pending five-minute approval timeout keeps the process alive after `SIGTERM`.
- The MCP server has one shutdown path. It shuts down when the transport closes, or on a signal. A second handler added "for safety", for example on stdin end, fires in situations nobody planned for.
- Every request path writes a response. Cancelling a request wakes whoever is waiting on it, and the body-size guard replies with 413 before it destroys the socket. Without that, long-poll responses get stranded and can block shutdown.
- The tool input is defined once, with zod. A hand-written JSON Schema kept next to a zod validator drifts out of step over time.

## Security notes

The broker only listens on loopback. Without further checks, that still leaves two ways for something else to approve a request.

- Any process on the machine can call `/approve`.
- A web page open in your browser can send a cross-site `POST` to `http://127.0.0.1:7777/approve` without needing to read the response (a "simple" request with no CORS preflight), or can use DNS rebinding to make the browser treat the broker as same-origin.

So the broker checks that the `Host` header is `127.0.0.1:<port>` or `localhost:<port>`, which defeats DNS rebinding. It also rejects any request that carries an `Origin` header. Browsers always send one on cross-site `POST`s, and the MCP server and `curl` don't. An optional shared secret, sent in the `x-broker-secret` header, also stops other local processes from approving or enqueuing. The README sets out what is protected and what is not.
