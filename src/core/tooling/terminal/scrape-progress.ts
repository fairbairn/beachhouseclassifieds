import chalk from "chalk";

type ProgressOptions = {
  script: string;
};

type ModeProgressLineInput = {
  mode: string;
  completed: number;
  total: number;
  startedAtMs: number;
  text: string;
};

const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/;

function roundToOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatPct(completed: number, total: number): string {
  if (total <= 0) {
    return "n/a%";
  }
  return `${roundToOne((completed / total) * 100)}%`;
}

function formatEtaMinutes(
  completed: number,
  total: number,
  elapsedSeconds: number,
): string {
  if (completed <= 0 || total <= completed || elapsedSeconds <= 0) {
    return "n/a min";
  }

  const throughputPerMinute = (completed / elapsedSeconds) * 60;
  if (!Number.isFinite(throughputPerMinute) || throughputPerMinute <= 0) {
    return "n/a min";
  }

  const remaining = Math.max(0, total - completed);
  return `${roundToOne(remaining / throughputPerMinute)} min`;
}

export function formatModeProgressLine(input: ModeProgressLineInput): string {
  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - input.startedAtMs) / 1000),
  );
  const modeToken = chalk.cyanBright(input.mode);
  const pctToken = chalk.yellowBright(formatPct(input.completed, input.total));
  const etaToken = chalk.greenBright(
    formatEtaMinutes(input.completed, input.total, elapsedSeconds),
  );

  return `${modeToken} ${pctToken} ${etaToken} - ${input.text}`;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function createScrapeProgress(options: ProgressOptions) {
  const scriptLabel = chalk.bgBlue.white.bold(` ${options.script} `);

  function styleTickMessage(message: string): string {
    if (ANSI_ESCAPE_PATTERN.test(message)) {
      return message;
    }
    const lowered = message.toLowerCase();
    if (
      lowered.includes("failed") ||
      lowered.includes("error") ||
      lowered.includes("timed out") ||
      lowered.includes("missing total amount")
    ) {
      return chalk.redBright(message);
    }
    if (lowered.includes("retry")) {
      return chalk.yellowBright(message);
    }
    if (lowered.includes("[api_rate_calls] window")) {
      return chalk.cyanBright(message);
    }
    return chalk.magenta(message);
  }

  function line(label: string, message: string): void {
    console.log(`${chalk.gray(stamp())} ${scriptLabel} ${label} ${message}`);
  }

  return {
    phase(message: string): void {
      line(chalk.bgCyan.black.bold(" phase "), chalk.cyan(message));
    },
    progress(message: string): void {
      line(chalk.bgBlueBright.white.bold(" prog  "), chalk.blueBright(message));
    },
    tick(message: string): void {
      line(chalk.bgMagenta.white.bold(" tick "), styleTickMessage(message));
    },
    info(message: string): void {
      line(chalk.bgWhite.black.bold(" info "), message);
    },
    success(message: string): void {
      line(chalk.bgGreen.black.bold(" done "), chalk.green(message));
    },
    warn(message: string): void {
      line(chalk.bgYellow.black.bold(" warn "), chalk.yellow(message));
    },
    failure(message: string): void {
      line(chalk.bgRed.white.bold(" fail "), chalk.red(message));
    },
  };
}
