#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { produceDeploymentValues } from "../lib/signed-handoff.mjs";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-local-qa") {
      values.allowLocalQa = true;
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${argument}`);
    }
    values[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return {
    artifactPath: values.artifact,
    candidateEvidencePath: values["candidate-evidence"],
    receiptPath: values.receipt,
    signaturePath: values.signature,
    trustedPublicKeyPath: values["trusted-public-key"],
    outputPath: values.output,
    expectedVersion: values.version,
    expectedCommit: values.commit,
    now: values.now,
    allowLocalQa: values.allowLocalQa === true,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await produceDeploymentValues(parseArguments(argv));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: result.outputPath,
    release: result.release,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`web handoff evidence rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
