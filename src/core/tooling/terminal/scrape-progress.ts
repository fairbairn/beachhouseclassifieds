import chalk from "chalk";

type ProgressOptions = {
  script: string;
};

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function createScrapeProgress(options: ProgressOptions) {
  const scriptLabel = chalk.bgBlue.white.bold(` ${options.script} `);

  function styleTickMessage(message: string): string {
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
