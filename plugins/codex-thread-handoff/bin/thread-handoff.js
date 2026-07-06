#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runCli } from "../src/cli.js";

const stdin = readFileSync(0, "utf8");
const result = await runCli(process.argv.slice(2), stdin, process.env);

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
