import { describe, expect, it, vi } from "vitest";

import {
  confirmSensitiveOperation,
  parseTargetCommandArgs,
  resolveCommandTarget,
} from "@/core/tooling/command-harness/run-command-with-target";

function parseFakeTarget(value: string | undefined) {
  if (value === "sqlite:local" || value === "postgres:dev") {
    return value;
  }

  return null;
}

describe("parseTargetCommandArgs", () => {
  const usage = "Usage: fake";

  it("parses target, mode, command, and args", () => {
    const parsed = parseTargetCommandArgs(
      [
        "--target",
        "sqlite:local",
        "--mode",
        "dev",
        "--",
        "npm",
        "run",
        "dev:raw",
      ],
      parseFakeTarget,
      usage,
    );

    expect(parsed.target).toBe("sqlite:local");
    expect(parsed.mode).toBe("dev");
    expect(parsed.command).toBe("npm");
    expect(parsed.commandArgs).toEqual(["run", "dev:raw"]);
  });

  it("supports --label as a backward-compatible alias", () => {
    const parsed = parseTargetCommandArgs(
      [
        "--target",
        "sqlite:local",
        "--label",
        "dev",
        "--",
        "npm",
        "run",
        "dev:raw",
      ],
      parseFakeTarget,
      usage,
    );

    expect(parsed.mode).toBe("dev");
  });

  it("throws on invalid target", () => {
    expect(() =>
      parseTargetCommandArgs(
        ["--target", "postgres:local", "--", "npm", "run", "dev:raw"],
        parseFakeTarget,
        usage,
      ),
    ).toThrow("Invalid --target");
  });

  it("throws when command separator is missing", () => {
    expect(() =>
      parseTargetCommandArgs(
        ["--target", "sqlite:local", "npm", "run", "dev:raw"],
        parseFakeTarget,
        usage,
      ),
    ).toThrow(usage);
  });
});

describe("resolveCommandTarget", () => {
  it("returns explicit target without prompting", async () => {
    const value = await resolveCommandTarget({
      target: "sqlite:local",
      mode: "dev",
      isInteractiveTerminal: true,
      noInteractiveTerminalErrorMessage: "no tty",
      promptForTarget: async () => "postgres:dev",
    });

    expect(value).toBe("sqlite:local");
  });

  it("throws configured error in non-interactive mode", async () => {
    await expect(
      resolveCommandTarget({
        target: null,
        mode: "dev",
        isInteractiveTerminal: false,
        noInteractiveTerminalErrorMessage: "no tty",
        promptForTarget: async () => "sqlite:local",
      }),
    ).rejects.toThrow("no tty");
  });

  it("handles abort-like prompt errors with graceful exit code", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as never);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        resolveCommandTarget({
          target: null,
          mode: "dev",
          isInteractiveTerminal: true,
          noInteractiveTerminalErrorMessage: "no tty",
          promptForTarget: async () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          },
        }),
      ).rejects.toThrow("process.exit:130");

      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(logSpy).toHaveBeenCalledWith("\nSelection cancelled.");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe("confirmSensitiveOperation", () => {
  it("does not prompt for non-sensitive modes", async () => {
    const promptSpy = vi.fn(async () => true);

    await expect(
      confirmSensitiveOperation({
        mode: "dev",
        isInteractiveTerminal: true,
        promptForConfirmation: promptSpy,
      }),
    ).resolves.toBeUndefined();

    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("throws for sensitive modes in non-interactive terminals", async () => {
    await expect(
      confirmSensitiveOperation({
        mode: "db:setup",
        isInteractiveTerminal: false,
      }),
    ).rejects.toThrow("interactive confirmation prompt");
  });

  it("continues when user confirms", async () => {
    const promptSpy = vi.fn(async () => true);

    await expect(
      confirmSensitiveOperation({
        mode: "db:seed",
        isInteractiveTerminal: true,
        promptForConfirmation: promptSpy,
      }),
    ).resolves.toBeUndefined();

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy).toHaveBeenCalledWith(
      expect.stringContaining("Proceed with db:seed"),
    );
  });

  it("exits cleanly when user declines", async () => {
    const promptSpy = vi.fn(async () => false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        confirmSensitiveOperation({
          mode: "db:setup",
          isInteractiveTerminal: true,
          promptForConfirmation: promptSpy,
        }),
      ).rejects.toThrow("process.exit:0");

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logSpy).toHaveBeenCalledWith("Operation cancelled.");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
