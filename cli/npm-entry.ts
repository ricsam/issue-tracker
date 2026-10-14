#!/usr/bin/env node
import { run } from "./index";
import { CliError, clean } from "./core";

// This entry is bundled for Node; unlike the importable command module it always runs.
run().catch(error => {
  // Arbitrary fetch/filesystem errors may include credentials. Only expose curated errors.
  console.error(`threadline: ${error instanceof CliError ? clean(error.message) : "Operation failed (storage or invalid server response)."}`);
  process.exitCode = error instanceof CliError ? error.code : 1;
});
