#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return process.argv[index + 1];
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PID ${child.pid} did not exit in time.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function connectable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const closed = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", closed);
    socket.once("timeout", closed);
  });
}

async function waitForListener(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await connectable(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production Web server did not listen on ${port}.`);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const evidenceDir = path.resolve(repositoryRoot, argumentValue("--evidence-dir"));
  const fixtureDir = path.join(evidenceDir, "manual-qa/fixture");
  const interruptedDir = path.join(evidenceDir, "interrupted");
  await fs.mkdir(interruptedDir, { recursive: true });
  const producer = path.join(repositoryRoot, "apps/web/tools/web-handoff-evidence-producer.mjs");
  const baseArguments = [
    producer,
    "--artifact", path.join(fixtureDir, "Agent-Calendar-1.2.3-arm64.dmg"),
    "--candidate-evidence", path.join(fixtureDir, "candidate.json"),
    "--receipt", path.join(fixtureDir, "receipt.json"),
    "--signature", path.join(fixtureDir, "receipt.sig"),
    "--trusted-public-key", path.join(fixtureDir, "release-public.pem"),
    "--version", "1.2.3",
    "--commit", "0123456789abcdef0123456789abcdef01234567",
    "--allow-local-qa",
  ];
  const producerInterruptions = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const outputPath = path.join(interruptedDir, `attempt-${attempt}.json`);
    await fs.rm(outputPath, { force: true });
    const child = spawn(process.execPath, [...baseArguments, "--output", outputPath], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    const exitPromise = waitForExit(child);
    child.kill("SIGSTOP");
    await new Promise((resolve) => setTimeout(resolve, 25));
    child.kill("SIGTERM");
    child.kill("SIGCONT");
    const exit = await exitPromise;
    const outputAbsent = await fs.access(outputPath).then(() => false, () => true);
    assert.equal(outputAbsent, true);
    producerInterruptions.push({ attempt, ...exit, outputAbsent });
  }

  const resumedOutput = path.join(interruptedDir, "resume.json");
  await fs.rm(resumedOutput, { force: true });
  const resumed = spawn(process.execPath, [...baseArguments, "--output", resumedOutput], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resumedStdout = "";
  let resumedStderr = "";
  resumed.stdout.on("data", (chunk) => { resumedStdout += chunk; });
  resumed.stderr.on("data", (chunk) => { resumedStderr += chunk; });
  const resumedExit = await waitForExit(resumed);
  assert.equal(resumedExit.code, 0, resumedStderr);
  assert.equal(JSON.parse(resumedStdout).ok, true);
  assert.equal(JSON.parse(await fs.readFile(resumedOutput, "utf8")).schemaVersion, 1);
  await fs.rm(resumedOutput);

  const port = await unusedPort();
  const localDeployment = JSON.parse(
    await fs.readFile(path.join(evidenceDir, "manual-qa/local-fixture-deployment-values.json"), "utf8"),
  );
  const server = spawn(
    "npm",
    ["--prefix", "apps/web", "run", "start", "--", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: repositoryRoot,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        WEB_HANDOFF_RELEASE_RECEIPT:
          localDeployment.values.WEB_HANDOFF_RELEASE_RECEIPT,
        WEB_HANDOFF_RELEASE_SIGNATURE:
          localDeployment.values.WEB_HANDOFF_RELEASE_SIGNATURE,
        WEB_HANDOFF_TRUSTED_PUBLIC_KEY:
          await fs.readFile(path.join(fixtureDir, "release-public.pem"), "utf8"),
        WEB_HANDOFF_LOCAL_QA: "1",
      },
    },
  );
  await waitForListener(port);
  assert.equal(await connectable(port), true);
  const productionHtml = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  assert.match(productionHtml, /Private beta 준비 중/);
  assert.doesNotMatch(productionHtml, /LOCAL QA FIXTURE/);
  const serverExitPromise = waitForExit(server);
  process.kill(-server.pid, "SIGTERM");
  const serverExit = await serverExitPromise;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await connectable(port), false);

  const partials = (await fs.readdir(interruptedDir))
    .filter((name) => name.includes(".partial-") || name === "resume.json");
  assert.deepEqual(partials, []);
  await fs.writeFile(
    path.join(evidenceDir, "interruption-qa.json"),
    `${JSON.stringify({
      ok: true,
      producerInterruptions,
      cancelResume: {
        resumedExit,
        parsedSuccessOutput: true,
        resumedOutputRemoved: true,
      },
      productionServerInterruption: {
        port: "<ephemeral>",
        listenedBeforeSignal: true,
        localQaReceiptRejectedByShippedProductionComposition: true,
        ...serverExit,
        listenerClosedAfterSignal: true,
      },
      partialOutputsRemaining: partials,
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
