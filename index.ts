#!/usr/bin/env bun

import { runCli } from "./src/cli.ts";

if (import.meta.main) {
  runCli();
}
