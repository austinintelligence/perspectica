import { describe, expect, it } from "vitest";
import { RequestGate } from "./request-gate";

describe("RequestGate", () => {
  it("releases capacity after a failed request", async () => {
    const gate = new RequestGate(1);
    await expect(
      gate.run(async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    await expect(gate.run(async () => "next")).resolves.toBe("next");
  });

  it("removes an aborted waiter without blocking later work", async () => {
    const gate = new RequestGate(1);
    let releaseFirst!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const controller = new AbortController();
    const aborted = gate.run(async () => "aborted", controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    releaseFirst();
    await first;
    await expect(gate.run(async () => "available")).resolves.toBe("available");
  });

  it("reports queue timing when capacity becomes available", async () => {
    const gate = new RequestGate(1);
    let releaseFirst!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    let diagnostics;
    const second = gate.run(
      async () => "second",
      undefined,
      (value) => {
        diagnostics = value;
      },
    );
    releaseFirst();
    await first;
    await expect(second).resolves.toBe("second");

    expect(diagnostics).toBeDefined();
    expect(diagnostics).toMatchObject({ limit: 1 });
    expect(diagnostics!.queueMs).toBeGreaterThanOrEqual(0);
  });
});
