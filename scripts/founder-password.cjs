#!/usr/bin/env node
/**
 * Generates the founder console's password hash.
 *
 *   node scripts/founder-password.cjs
 *
 * The password is read from the terminal with echo off, hashed with bcrypt,
 * and only the hash is printed. It is never echoed, never written to a file,
 * never put in an argument (where `ps` and shell history would find it), and
 * never logged. Paste the printed line into the control-plane host's .env.
 *
 * There is no way back from the hash to the password. Losing it means setting
 * a new one, which is the correct trade.
 */

const path = require("path");
const readline = require("readline");

// bcryptjs is a server dependency; this script lives a directory up from it.
const bcrypt = require(
  path.resolve(__dirname, "..", "server", "node_modules", "bcryptjs")
);

const MIN_LENGTH = 12;

/** Reads a line with the terminal's echo suppressed. */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;

    if (!input.isTTY) {
      reject(
        new Error(
          "Run this from a terminal. Piping the password in would leave it in shell history."
        )
      );
      return;
    }

    const rl = readline.createInterface({ input, output, terminal: true });
    output.write(prompt);

    // Swallow the echoed characters rather than printing them.
    const onData = () => output.write("");
    input.on("data", onData);
    const previousWrite = rl._writeToOutput;
    rl._writeToOutput = () => {};

    rl.question("", (answer) => {
      rl._writeToOutput = previousWrite;
      input.removeListener("data", onData);
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}

(async () => {
  try {
    const password = await readHidden("Founder password: ");
    const again = await readHidden("Again: ");

    if (password !== again) {
      console.error("They do not match. Nothing was generated.");
      process.exit(1);
    }
    if (password.length < MIN_LENGTH) {
      console.error(
        `Use at least ${MIN_LENGTH} characters. This is the only credential guarding every customer's configuration.`
      );
      process.exit(1);
    }

    const hash = bcrypt.hashSync(password, 12);

    console.log("");
    console.log("Add these to the control-plane host's .env:");
    console.log("");
    console.log("FOUNDER_CONSOLE_ENABLED=true");
    console.log(`FOUNDER_PASSWORD_HASH=${hash}`);
    console.log("PLATFORM_STATE_DIR=/absolute/path/to/deployments");
    console.log("");
    console.log(
      "Only on the host that holds deployments/. Never in a customer's deployment,"
    );
    console.log("and never in this repository.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
