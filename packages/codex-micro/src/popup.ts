// Key-map popup TUI: draws popup-frame's picture of the six Agent Keys from
// the daemon's watch stream, again on every status and every resize. Keys:
// p toggles sticky/mirror, q / esc / ctrl+c closes.
import { sendCommand, watchStatus, type StatusPayload } from "./control.js";
import { frame } from "./popup-frame.js";

// Outside a TTY there is no size to read; this is what Herdr gives the
// manifest's 160x22 popup (border and scrollbar column taken).
const FALLBACK_COLUMNS = 157;
const FALLBACK_ROWS = 20;

// Autowrap off: string-width and the pane's emulator can still disagree on a
// grapheme's width, and an overlong line then clips instead of wrapping into
// the next row. The cursor is hidden; nothing here takes text input.
const ENTER = "\x1b[?1049h\x1b[?7l\x1b[?25l";
const LEAVE = "\x1b[?25h\x1b[?7h\x1b[?1049l";

let status: StatusPayload | null = null;
let connected = true;

// No trailing newline: on a frame that fills every row it would scroll the
// top line away.
function render(): void {
  const lines = frame(
    status,
    connected,
    process.stdout.columns ?? FALLBACK_COLUMNS,
    process.stdout.rows ?? FALLBACK_ROWS,
  );
  process.stdout.write("\x1b[H\x1b[2J" + lines.join("\r\n"));
}

const watcher = watchStatus(
  (payload) => {
    status = payload;
    connected = true;
    render();
  },
  () => {
    connected = false;
    render();
  },
);

function quit(): void {
  watcher.stop();
  process.exit(0);
}

// The alternate buffer keeps the popup from scribbling over whatever was on
// screen; leaving it restores the caller's view when run outside a Herdr pane.
// Restored on exit, so a crash does not leave the cursor hidden either.
process.on("exit", () => {
  process.stdin.setRawMode?.(false);
  process.stdout.write(LEAVE);
});
process.stdout.write(ENTER);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const key = data.toString("utf8");
  if (key === "q" || key === "\x1b" || key === "\x03") quit();
  if (key === "p") void sendCommand("toggle-policy").catch(() => {});
});
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
process.stdout.on("resize", render);
render();
