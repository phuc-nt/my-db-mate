#!/usr/bin/env node
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`(node) ${warning.name}: ${warning.message}
`);
});
void import("./assets/cli-main-C1lsyHux.js").then((n) => n.c);
