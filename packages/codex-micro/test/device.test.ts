import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Device, HIDAsync } from "node-hid";
import { encodeMessage, Reassembler } from "../src/framing.js";

const { devicesAsync } = vi.hoisted(() => ({
  devicesAsync: vi.fn<() => Promise<Device[]>>(),
}));
vi.mock("node-hid", () => ({ devicesAsync, HIDAsync: class {} }));

const {
  USAGE_PAGE,
  VENDOR_ID,
  classifyOpenError,
  findCandidates,
  firmwareSupported,
  parseFirmwareVersion,
  readFirmwareVersion,
  statusReplyVersion,
} = await import("../src/device.js");

function hid(productId: number, overrides: Partial<Device> = {}): Device {
  return {
    vendorId: VENDOR_ID,
    productId,
    usagePage: USAGE_PAGE,
    path: `path-${productId.toString(16)}`,
    release: 0,
    interface: 0,
    ...overrides,
  };
}

describe("findCandidates", () => {
  beforeEach(() => devicesAsync.mockReset());

  it("accepts the Codex Micro and both Creator Micro 2 variants", async () => {
    devicesAsync.mockResolvedValue([hid(0x8297), hid(0x8298), hid(0x8360)]);
    const ids = (await findCandidates()).map((d) => d.productId);
    expect(ids).toEqual([0x8360, 0x8297, 0x8298]);
  });

  it("rejects other products, vendors, usage pages, and pathless entries", async () => {
    devicesAsync.mockResolvedValue([
      hid(0x8294),
      hid(0x8360, { vendorId: 0x05ac }),
      hid(0x8360, { usagePage: 0x01 }),
      hid(0x8360, { path: undefined }),
    ]);
    expect(await findCandidates()).toEqual([]);
  });
});

describe("classifyOpenError", () => {
  it("treats not permitted (0xE00002E2) as a missing grant", () => {
    expect(
      classifyOpenError(
        "cannot open device with path x: hid_open_path: failed to open IOHIDDevice from mach entry: (0xE00002E2) (iokit/common) not permitted",
      ),
    ).toBe("permission_required");
    expect(classifyOpenError("open failed: E00002E2")).toBe(
      "permission_required",
    );
  });

  it("keeps privilege violation, exclusive access, and absence apart", () => {
    expect(classifyOpenError("(0xE00002C1) privilege violation")).toBe(
      "permission_required",
    );
    expect(classifyOpenError("(0xE00002C5) exclusive access")).toBe(
      "device_busy",
    );
    expect(classifyOpenError("device not found")).toBe("device_absent");
    expect(classifyOpenError("something else")).toBe("connecting");
  });
});

describe("firmware version", () => {
  it("parses versions with and without a leading v", () => {
    expect(parseFirmwareVersion("0.6.3")).toEqual([0, 6, 3]);
    expect(parseFirmwareVersion("v0.4.1")).toEqual([0, 4, 1]);
    expect(parseFirmwareVersion("0.7.0-rc.11")).toEqual([0, 7, 0]);
    expect(parseFirmwareVersion("unknown")).toBeNull();
  });

  it("requires 0.6.3 or newer", () => {
    expect(firmwareSupported([0, 6, 3])).toBe(true);
    expect(firmwareSupported([0, 6, 10])).toBe(true);
    expect(firmwareSupported([0, 7, 0])).toBe(true);
    expect(firmwareSupported([1, 0, 0])).toBe(true);
    expect(firmwareSupported([0, 6, 2])).toBe(false);
    expect(firmwareSupported([0, 4, 1])).toBe(false);
  });
});

describe("statusReplyVersion", () => {
  it("reads the version from the device.status reply framed by the device", () => {
    const reply =
      '{"result":{"version":"0.6.3","profile_index":0,"layer_index":1,"battery":87,"is_charging":true},"id":7,"method":"device.status"}';
    const reassembler = new Reassembler();
    const messages = encodeMessage(reply + "\n").flatMap((report) =>
      reassembler.push(report),
    );
    expect(messages.map((m) => statusReplyVersion(m.message))).toEqual([
      "0.6.3",
    ]);
  });

  it("ignores lighting acknowledgements, notifications, and other ids", () => {
    expect(
      statusReplyVersion(
        '{"result":{"ok":1},"id":null,"method":"v.oai.thstatus"}',
      ),
    ).toBeNull();
    expect(
      statusReplyVersion('{"m":"v.oai.hid","p":{"k":"AG00","act":1}}'),
    ).toBeNull();
    expect(
      statusReplyVersion('{"result":{"version":"0.6.3"},"id":8}'),
    ).toBeNull();
    expect(statusReplyVersion("null")).toBeNull();
    expect(statusReplyVersion("not json")).toBeNull();
  });
});

describe("readFirmwareVersion", () => {
  const STATUS_REPLY =
    '{"result":{"version":"0.6.3","profile_index":0,"layer_index":1,"battery":87,"is_charging":true},"id":7,"method":"device.status"}';

  // Device-to-host frames: newline-terminated, report id as byte 0.
  function deviceReports(message: string, channel = 2): Buffer[] {
    return encodeMessage(message + "\n").map((report) => {
      report[1] = channel;
      return report;
    });
  }

  // An open handle as node-hid exposes it: reports arrive one "data" event
  // each, and write resolves once the report is sent.
  function fakeDevice(respond: (written: Buffer[]) => Buffer[]) {
    const written: Buffer[] = [];
    const device = Object.assign(new EventEmitter(), {
      write: vi.fn(async (report: Buffer) => {
        written.push(report);
        setImmediate(() => {
          for (const data of respond(written)) device.emit("data", data);
        });
        return report.length;
      }),
    });
    return { device, handle: device as unknown as HIDAsync, written };
  }

  afterEach(() => vi.useRealTimers());

  it("sends one device.status request without a trailing newline", async () => {
    const { handle, written } = fakeDevice(() => deviceReports(STATUS_REPLY));
    await readFirmwareVersion(handle, 1000);
    const request = written
      .map((report) => report.subarray(3, 3 + report[2]!).toString("utf8"))
      .join("");
    expect(request).toBe('{"method":"device.status","params":null,"id":7}');
  });

  it("finds the reply among partial reports, acknowledgements, notifications, and other channels", async () => {
    const tail = deviceReports('"ok":1},"id":null,"method":"v.oai.thstatus"}');
    const reply = deviceReports(STATUS_REPLY);
    expect(reply.length).toBeGreaterThan(1);
    const { device, handle } = fakeDevice(() => [
      ...tail,
      ...deviceReports(
        '{"result":{"ok":1},"id":null,"method":"v.oai.thstatus"}',
      ),
      ...deviceReports('{"m":"v.oai.hid","p":{"k":"AG00","act":1}}'),
      reply[0]!,
      ...deviceReports('{"result":{"version":"9.9.9"},"id":7}', 1),
      ...reply.slice(1),
    ]);
    expect(await readFirmwareVersion(handle, 1000)).toBe("0.6.3");
    expect(device.listenerCount("data")).toBe(0);
    expect(device.listenerCount("error")).toBe(0);
  });

  it("reports no version when the device does not answer in time", async () => {
    vi.useFakeTimers();
    const { device, handle } = fakeDevice(() =>
      deviceReports('{"result":{"ok":1},"id":null,"method":"v.oai.thstatus"}'),
    );
    const version = readFirmwareVersion(handle, 1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await version).toBeNull();
    expect(device.listenerCount("data")).toBe(0);
    expect(device.listenerCount("error")).toBe(0);
  });

  it("reports no version when the write fails", async () => {
    const { device, handle } = fakeDevice(() => []);
    device.write.mockRejectedValueOnce(new Error("could not write"));
    expect(await readFirmwareVersion(handle, 1000)).toBeNull();
    expect(device.listenerCount("data")).toBe(0);
  });

  it("reports no version when the handle fails mid-read", async () => {
    const { device, handle } = fakeDevice(() => {
      device.emit("error", new Error("device disconnected"));
      return [];
    });
    // Past the test timeout, so only the error itself can settle it.
    expect(await readFirmwareVersion(handle, 60_000)).toBeNull();
    expect(device.listenerCount("error")).toBe(0);
  });
});
