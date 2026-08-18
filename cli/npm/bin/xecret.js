#!/usr/bin/env node
'use strict';

/**
 * The `xecret` command, as npm installs it.
 *
 * This file exists only to hand control to the real binary. It parses nothing,
 * rewrites nothing, and reads no argument — `xecret run -- npm run dev` must
 * mean the same thing however xecret was installed, and the only way to
 * guarantee that is for this layer to have no opinions.
 *
 * ── The one honest cost of installing through npm ──
 * There is a Node process in front of the binary for the life of the command.
 * `stdio: 'inherit'` means the child owns the terminal directly, so prompts,
 * colours, pipes and Ctrl-C all behave; but a `xecret run` under npm holds two
 * processes where brew or the install script hold one. For long-running
 * processes — the golden path — prefer the standalone binary. This exists so
 * that a team already running `npm ci` in CI does not have to add a second
 * package manager to get one tool.
 *
 * Nothing about a secret passes through here: values go from the server into
 * the child process's environment, inside the binary. This process never sees
 * one, and deliberately has no code that could.
 */

const { spawnSync } = require('node:child_process');
const { constants } = require('node:os');

const { resolveBinary } = require('../lib/resolve.js');

let binary;
try {
  binary = resolveBinary();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`xecret: could not start ${binary}: ${result.error.message}\n`);
  process.exit(1);
}

/**
 * A child killed by a signal is reported the way a shell reports it — 128 plus
 * the signal number — rather than re-raised. Re-raising would depend on this
 * process's own handlers for SIGINT, which Node installs and a wrapper should
 * not be reasoning about. `xecret run` already forwards signals to *its* child;
 * this only has to report the outcome faithfully.
 */
if (result.signal) {
  const number = constants.signals[result.signal];
  process.exit(number === undefined ? 1 : 128 + number);
}

// `status` is null only when a signal ended it, handled above.
process.exit(result.status === null ? 1 : result.status);
