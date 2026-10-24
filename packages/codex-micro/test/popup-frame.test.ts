import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { SlotStatus, StatusPayload } from "../src/control.js";
import { frame, layout } from "../src/popup-frame.js";
import { displayWidth } from "../src/text.js";

const slot = (
  key: number,
  status: SlotStatus["status"],
  paneName: string | null,
  agent: string,
  tab: string,
  workspace: string,
  cwd: string,
): SlotStatus => ({
  key,
  paneId: `p${key}`,
  agent,
  paneName,
  workspace,
  tab,
  cwd,
  status,
});

const base: StatusPayload = {
  policy: "sticky",
  scrollSteps: 3,
  dialMode: "scroll",
  dialModeOrder: ["scroll"],
  state: "connected",
  herdrConnected: true,
  configError: null,
  slots: [
    slot(
      1,
      "working",
      "api refactor",
      "claude",
      "review",
      "house-of-herdr",
      "/Users/me/Projects/house-of-herdr-pr-6-review/packages/codex-micro",
    ),
    slot(
      2,
      "blocked",
      null,
      "codex",
      "main",
      "engine",
      "/Users/me/Projects/engine",
    ),
    slot(
      3,
      "done",
      "日本語のペイン名前テスト",
      "claude",
      "tab 🚀 emoji",
      "ws",
      "/tmp",
    ),
    null,
    slot(
      5,
      "idle",
      "x",
      "pi",
      "t",
      "a-very-long-workspace-name-that-will-clip",
      "/",
    ),
    slot(
      6,
      "unknown",
      "👩‍👩‍👧‍👦 family",
      "codex",
      "漢字漢字漢字漢字漢字漢字漢字漢字",
      "w",
      "/Users/me/日本語/ディレクトリ",
    ),
  ],
};

const warnings: StatusPayload = {
  ...base,
  state: "permission_required",
  herdrConnected: false,
  configError: `bindings.ACT03: unknown action "frobnicate"; ${"x".repeat(200)}`,
};

const fixtures: [string, StatusPayload | null, boolean][] = [
  ["mixed", base, true],
  ["every warning", warnings, false],
  ["all empty", { ...base, slots: [null, null, null, null, null, null] }, true],
  ["connecting", null, true],
];

const visible = (lines: string[]) => lines.map(stripVTControlCharacters);

const range = (from: number, to: number, step = 1) =>
  Array.from(
    { length: Math.floor((to - from) / step) + 1 },
    (_, i) => from + i * step,
  );

// Herdr gives a popup pty at least 4x2 cells and at most the tab; the
// manifest's 160x22 resolves to 157x20. Narrow panes and every height up to
// the manifest's are swept cell by cell, wider panes at a step of 5 (coprime
// with the 2- and 4-column cadence at which box widths change), plus each
// side of every tier boundary and box-width cap: pairs from 41, pairs capped
// at 77, the keypad from 107, the keypad capped at 155.
const COLUMNS = [
  ...new Set([
    ...range(4, 45),
    ...range(45, 200, 5),
    76,
    77,
    78,
    106,
    107,
    108,
    154,
    155,
    156,
    157,
  ]),
];
const ROWS = [...range(2, 22), 26, 30];

describe("popup frame", () => {
  it.each(fixtures)(
    "fits every pane size with square boxes, never wrapping or scrolling (%s)",
    (_name, status, connected) => {
      // Collected, not asserted per line: one expect per line of every size
      // costs seconds, and the list of misfits is the useful failure.
      const misfits: string[] = [];
      for (const columns of COLUMNS) {
        for (const rows of ROWS) {
          const lines = visible(frame(status, connected, columns, rows));
          if (lines.length > rows)
            misfits.push(`${columns}x${rows}: ${lines.length} rows`);
          // Every line of a row of boxes, top border to bottom, is as wide as
          // the top border, or a right border is out of line.
          let boxRow: number | null = null;
          for (const line of lines) {
            const width = displayWidth(line);
            if (width > columns) misfits.push(`${columns}x${rows}: ${line}`);
            if (line.includes("┌")) boxRow = width;
            else if (boxRow !== null && width !== boxRow)
              misfits.push(`${columns}x${rows} ragged: ${line}`);
            if (line.includes("└")) boxRow = null;
          }
        }
      }
      expect(misfits).toEqual([]);
    },
  );

  it("shows every key with its status on any pane of at least six rows", () => {
    for (const columns of COLUMNS.filter((c) => c >= 15)) {
      for (const rows of ROWS.filter((r) => r >= 6)) {
        const text = visible(frame(warnings, false, columns, rows)).join("\n");
        for (const s of warnings.slots) {
          if (s)
            expect(text, `${columns}x${rows}`).toContain(
              `[${s.key}] ● ${s.status}`,
            );
        }
        expect(text, `${columns}x${rows}`).toContain("[4]");
      }
    }
  });

  it("keeps every warning on screen at the manifest height", () => {
    for (const columns of COLUMNS.filter((c) => c >= 30)) {
      const text = visible(frame(warnings, false, columns, 20)).join("\n");
      expect(text, `${columns}`).toContain("device: Input Monitoring");
      expect(text, `${columns}`).toContain("daemon disconnected");
      expect(text, `${columns}`).toContain("herdr disconnected");
      expect(text, `${columns}`).toContain("config error: ");
    }
  });

  it("titles the header only when it all fits on one line", () => {
    expect(visible(frame(base, true, 157, 20)).join("\n")).toContain(
      "Codex Micro",
    );
    expect(visible(frame(base, true, 60, 20)).join("\n")).not.toContain(
      "Codex Micro",
    );
  });

  it("drops box lines from the cwd end as rows run out", () => {
    const one: StatusPayload = {
      ...base,
      slots: [
        slot(1, "idle", "NAME", "a", "TAB", "WORKSPACE", "/CWD"),
        null,
        null,
        null,
        null,
        null,
      ],
    };
    const shown = (rows: number) => {
      const text = visible(frame(one, true, 157, rows)).join("\n");
      return ["NAME", "TAB", "WORKSPACE", "/CWD"].filter((f) =>
        text.includes(f),
      );
    };
    expect([20, 14, 12, 10].map(shown)).toEqual([
      ["NAME", "TAB", "WORKSPACE", "/CWD"],
      ["NAME", "TAB", "WORKSPACE"],
      ["NAME", "TAB"],
      ["NAME"],
    ]);
  });

  it("leaves the tab and workspace off a list line with no room to show them", () => {
    const keyOne = (columns: number) =>
      visible(frame(base, true, columns, 8)).find((line) =>
        line.includes("[1]"),
      );
    expect(keyOne(41)).toBe("  [1] ● working  api refactor (claude)");
    expect(keyOne(42)).toBe("  [1] ● working  api refactor (claude)  r…");
  });

  it("gives a row the list leaves over to the footer, not the rule", () => {
    const lines = visible(frame(base, true, 157, 8));
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toContain("q close");
    expect(lines.join("\n")).not.toContain("───");
  });
});

describe("popup layout", () => {
  it("mirrors the keypad while four readable boxes fit across", () => {
    expect(layout(157, 17)).toMatchObject({
      kind: "boxes",
      rows: [
        [1, 2],
        [3, 4, 5, 6],
      ],
      cell: 36,
      fields: 4,
    });
    expect(layout(107, 17)).toMatchObject({
      kind: "boxes",
      rows: [
        [1, 2],
        [3, 4, 5, 6],
      ],
      cell: 24,
    });
  });

  it("folds the bottom row into pairs below that", () => {
    expect(layout(106, 17)).toMatchObject({
      kind: "boxes",
      rows: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      cell: 36,
      fields: 3,
    });
    expect(layout(41, 17)).toMatchObject({
      kind: "boxes",
      rows: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      cell: 18,
    });
  });

  it("lists the keys when no boxes fit", () => {
    expect(layout(40, 12)).toEqual({ kind: "list", detail: true });
    expect(layout(40, 11)).toEqual({ kind: "list", detail: false });
    expect(layout(157, 6)).toMatchObject({ kind: "boxes", fields: 1 });
    expect(layout(157, 5)).toEqual({ kind: "list", detail: false });
    expect(layout(106, 9)).toMatchObject({ kind: "boxes", fields: 1 });
    expect(layout(106, 8)).toEqual({ kind: "list", detail: false });
  });
});
