// The key-map popup's screen, as a pure function of daemon status and pane
// size. Herdr clamps the popup to the tab, so the pane can be anything from a
// few cells to the manifest's full size; every line returned fits `columns`
// and there are never more than `rows` of them, or the terminal would wrap
// lines into phantom frames and scroll the header away.
//
// The boxes mirror the keypad (two keys centered over four) while four fit
// across; narrower panes fold the bottom four into pairs, and below that each
// key becomes one list line. Short panes drop box fields from the least
// telling end: cwd, then workspace, then tab.
import type { ControlState, SlotStatus, StatusPayload } from "./control.js";
import { STATUS_COLORS } from "./lights.js";
import { SLOT_COUNT, type AgentStatus } from "./slots.js";
import { clipEnd, clipStart, displayWidth, padTo, sanitize } from "./text.js";

const MARGIN = 2; // left indent shared by the header, rule, boxes and footer
const GAP = 3; // columns between boxes
const SEP = "    "; // between header indicators on one line
const MAX_CELL = 36;
const MAX_FIELDS = 4; // name, tab, workspace, cwd

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = 0xff5555;

const STATE_LABELS: Record<ControlState, [number, string]> = {
  connected: [0x22cc55, "connected"],
  connecting: [0xffaa00, "connecting…"],
  yielded: [0xffaa00, "yielded to Codex app"],
  device_absent: [RED, "not found"],
  permission_required: [RED, "Input Monitoring permission required"],
  device_busy: [RED, "held by another app"],
  stopped: [RED, "released"],
};

function tag(key: number, status: AgentStatus): string {
  return `[${key}] ● ${status}`;
}

// The widest tag sets both the list's name column and the narrowest box: a
// box top border is a corner, the tag in spaces, at least one dash, a corner.
const TAG_WIDTH = Math.max(
  ...Object.keys(STATUS_COLORS).map((s) =>
    displayWidth(tag(SLOT_COUNT, s as AgentStatus)),
  ),
);
const MIN_CELL = TAG_WIDTH + 5;

// Box arrangements, preferred first: the keypad itself, then keys 1 and 2
// still on top with the bottom four folded into pairs. The keypad shape needs
// wider boxes than the tag alone: at 24 columns a box holds a 20-column
// "pane (agent)" name, and below that, pairs of wider boxes read better.
const ARRANGEMENTS = [
  {
    rows: [
      [1, 2],
      [3, 4, 5, 6],
    ],
    minCell: 24,
  },
  {
    rows: [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
    minCell: MIN_CELL,
  },
];

export type Layout =
  | {
      kind: "boxes";
      rows: number[][];
      cell: number; // outer box width
      grid: number; // width of the widest row of boxes
      fields: number; // text lines inside each box
      gaps: boolean; // a blank line between box rows
      padded: boolean; // and around the header, rule and footer
    }
  | { kind: "list"; detail: boolean };

// `budget` is the rows left for the keys once the header, rule and footer
// are placed. The first arrangement whose boxes are wide enough and tall
// enough for one field wins; otherwise a list. Spare rows become blank lines.
export function layout(columns: number, budget: number): Layout {
  for (const { rows, minCell } of ARRANGEMENTS) {
    const across = Math.max(...rows.map((row) => row.length));
    const fit = Math.floor((columns - MARGIN - (across - 1) * GAP) / across);
    const cell = Math.min(MAX_CELL, fit);
    const fields = Math.min(MAX_FIELDS, Math.floor(budget / rows.length) - 2);
    if (cell >= minCell && fields >= 1) {
      const spare = budget - rows.length * (fields + 2);
      return {
        kind: "boxes",
        rows,
        cell,
        grid: span(across, cell),
        fields,
        gaps: spare >= rows.length - 1,
        padded: spare >= rows.length + 2,
      };
    }
  }
  return { kind: "list", detail: budget >= 2 * SLOT_COUNT };
}

// Columns taken by `count` boxes side by side.
function span(count: number, cell: number): number {
  return count * cell + (count - 1) * GAP;
}

function fg(color: number): string {
  return `\x1b[38;2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}m`;
}

function slotName(slot: SlotStatus): string {
  return sanitize(
    slot.paneName ? `${slot.paneName} (${slot.agent})` : slot.agent,
  );
}

function box(
  slot: SlotStatus | null,
  key: number,
  cell: number,
  fields: number,
): string[] {
  const inner = cell - 4;
  const row = (text: string, style = "") =>
    `│ ${style ? style + padTo(text, inner) + RESET : padTo(text, inner)} │`;
  const bottom = "└" + "─".repeat(cell - 2) + "┘";
  if (!slot) {
    const body = Array.from({ length: fields }, () => row(""));
    body[Math.floor((fields - 1) / 2)] = row(
      "· empty ·".padStart(Math.floor((inner + 9) / 2)),
    );
    const top = `┌ [${key}] ` + "─".repeat(cell - 7) + "┐";
    return [top, ...body, bottom].map((line) => DIM + line + RESET);
  }
  const color = fg(STATUS_COLORS[slot.status]);
  const label = ` ${tag(key, slot.status)} `;
  const top = "┌" + label + "─".repeat(cell - 2 - displayWidth(label)) + "┐";
  const body = [
    row(clipEnd(slotName(slot), inner)),
    row(clipEnd(sanitize(slot.tab), inner)),
    row(clipEnd(sanitize(slot.workspace), inner)),
    row(clipStart(sanitize(slot.cwd), inner), DIM),
  ];
  return [
    color + BOLD + top + RESET,
    ...body.slice(0, fields),
    color + bottom + RESET,
  ];
}

function boxes(
  slots: (SlotStatus | null)[],
  { rows, cell, grid, fields, gaps }: Extract<Layout, { kind: "boxes" }>,
): string[] {
  const out: string[] = [];
  rows.forEach((keys, i) => {
    if (gaps && i > 0) out.push("");
    const indent = " ".repeat(
      MARGIN + Math.floor((grid - span(keys.length, cell)) / 2),
    );
    const drawn = keys.map((key) =>
      box(slots[key - 1] ?? null, key, cell, fields),
    );
    for (let line = 0; line < fields + 2; line++) {
      out.push(indent + drawn.map((b) => b[line]).join(" ".repeat(GAP)));
    }
  });
  return out;
}

// One line per key: the colored tag, padded so names align, then the name.
// The tab and workspace follow dim on the same line when at least a character
// and an ellipsis fit, or on a line of their own when `detail` grants the rows.
function list(
  slots: (SlotStatus | null)[],
  width: number,
  detail: boolean,
): string[] {
  const lead = TAG_WIDTH + 2;
  const room = width - lead;
  const indent = " ".repeat(MARGIN);
  const out: string[] = [];
  for (let key = 1; key <= SLOT_COUNT; key++) {
    const slot = slots[key - 1] ?? null;
    const style = slot ? fg(STATUS_COLORS[slot.status]) + BOLD : DIM;
    const label = slot ? tag(key, slot.status) : `[${key}]`;
    if (room <= 0) {
      // Too narrow for a name column: the tag alone still maps key to status.
      out.push(indent + style + clipEnd(label, width) + RESET);
      if (detail) out.push("");
      continue;
    }
    const name = clipEnd(slot ? slotName(slot) : "· empty ·", room);
    const more = slot ? sanitize(`${slot.tab} · ${slot.workspace}`) : "";
    const rest = room - displayWidth(name) - 2;
    const inline =
      !detail && more && rest >= 2 ? "  " + clipEnd(more, rest) : "";
    out.push(
      indent +
        style +
        padTo(label, lead) +
        RESET +
        (slot ? "" : DIM) +
        name +
        DIM +
        inline +
        RESET,
    );
    if (detail)
      out.push(indent + " ".repeat(lead) + DIM + clipEnd(more, room) + RESET);
  }
  return out;
}

// Indicators fill lines left to right and wrap whole, so a warning is never
// cut in half by a neighbor; one too wide for any line is clipped. The
// popup's border already names it, so the title only claims leftover room.
function header(
  status: StatusPayload,
  connected: boolean,
  width: number,
): string[] {
  const [color, device] = STATE_LABELS[status.state];
  const dial =
    status.dialMode === "scroll"
      ? `${status.dialMode} (${status.scrollSteps}×)`
      : status.dialMode;
  const items: [string, string, string][] = [
    ["", "Codex Micro", BOLD],
    ["policy: ", status.policy.toUpperCase(), BOLD],
    ["dial: ", dial, BOLD],
    ["device: ", device, fg(color)],
  ];
  if (!connected) items.push(["", "daemon disconnected", fg(RED)]);
  if (!status.herdrConnected) items.push(["", "herdr disconnected", fg(RED)]);
  const oneLine = items.map(([label, value]) => label + value).join(SEP);
  const shown = displayWidth(oneLine) <= width ? items : items.slice(1);

  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const [label, value, style] of shown) {
    const plain = label + value;
    const fits = displayWidth(plain) <= width;
    const text = fits
      ? label + style + value + RESET
      : style + clipEnd(plain, width) + RESET;
    // A clipped item fills its line, so `width` stands in for its exact width.
    const w = Math.min(displayWidth(plain), width);
    if (used > 0 && used + SEP.length + w > width) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += (used > 0 ? SEP : "") + text;
    used += (used > 0 ? SEP.length : 0) + w;
  }
  lines.push(line);
  if (status.configError) {
    // A validation message is unbounded; it gets one clipped line.
    const message = clipEnd(
      `config error: ${sanitize(status.configError)}`,
      width,
    );
    lines.push(fg(RED) + message + RESET);
  }
  return lines;
}

export function frame(
  status: StatusPayload | null,
  connected: boolean,
  columns: number,
  rows: number,
): string[] {
  const width = columns - MARGIN;
  const indent = " ".repeat(MARGIN);
  if (!status) {
    return [indent + clipEnd("connecting to codex-micro daemon...", width)];
  }
  const head = header(status, connected, width).map((line) => indent + line);
  const plan = layout(columns, rows - head.length - 2);
  const body =
    plan.kind === "boxes"
      ? boxes(status.slots, plan)
      : list(status.slots, width, plan.detail);
  const rule =
    indent +
    DIM +
    "─".repeat(plan.kind === "boxes" ? plan.grid : width) +
    RESET;
  const footer =
    indent + DIM + clipEnd("p toggle policy · q close", width) + RESET;
  const lines =
    plan.kind === "boxes" && plan.padded
      ? ["", ...head, rule, "", ...body, "", footer]
      : [...head, rule, ...body, footer];
  if (lines.length <= rows) return lines;
  // Only a list can overrun (boxes are chosen to fit): the keys outrank the
  // chrome, the header's last lines, its warnings, outrank its first, and a
  // row left over goes to the footer before the rule.
  const cut = Math.max(0, head.length + body.length - rows);
  return [...head.slice(cut), ...body, footer].slice(0, rows);
}
