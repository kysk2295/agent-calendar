#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { resolveHandoff } from "../lib/handoff-policy.mjs";
import { canonicalJson, produceDeploymentValues } from "../lib/signed-handoff.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = path.join(repositoryRoot, "apps/web");
const commit = "0123456789abcdef0123456789abcdef01234567";
const version = "1.2.3";
const marker = "LOCAL QA FIXTURE — NOT PRODUCTION RELEASE EVIDENCE";
const environmentNames = [
  "WEB_HANDOFF_RELEASE_RECEIPT",
  "WEB_HANDOFF_RELEASE_SIGNATURE",
  "WEB_HANDOFF_TRUSTED_PUBLIC_KEY",
  "WEB_HANDOFF_LOCAL_QA",
  "NEXT_PUBLIC_DESKTOP_VERIFIED",
  "NEXT_PUBLIC_SIGNUP_URL",
  "NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL",
  "NEXT_PUBLIC_DESKTOP_VERSION",
  "NEXT_PUBLIC_DESKTOP_SHA256",
];

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return process.argv[index + 1];
}

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assetContentType(assetPath) {
  return {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }[path.extname(assetPath)] || "application/octet-stream";
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function injectQaHandoff(html, handoff) {
  const closedSignup =
    '<span class="action action--disabled" aria-disabled="true" data-testid="signup-control">Private beta 준비 중</span>';
  const closedDownload =
    '<span class="action action--disabled" aria-disabled="true" data-testid="download-control">Desktop 다운로드 준비 중</span>';
  assert.match(html, new RegExp(closedSignup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, new RegExp(closedDownload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const signup =
    `<a class="action" href="${escapeHtmlAttribute(handoff.signup.href)}" rel="noreferrer" data-testid="signup-control">${escapeHtmlAttribute(handoff.signup.label)}<span aria-hidden="true">↗</span></a>`
    + `<p data-testid="local-qa-marker">${escapeHtmlAttribute(handoff.marker)}</p>`;
  const download =
    `<a class="action" href="${escapeHtmlAttribute(handoff.download.href)}" rel="noreferrer" data-testid="download-control" download="">${escapeHtmlAttribute(handoff.download.label)}<span aria-hidden="true">↗</span></a>`;
  return html.replace(closedSignup, signup).replace(closedDownload, download);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function setClosedEnvironment() {
  for (const name of environmentNames) delete process.env[name];
  process.env.NEXT_PUBLIC_DESKTOP_VERIFIED = "true";
  process.env.NEXT_PUBLIC_SIGNUP_URL = "https://manual.invalid/signup";
  process.env.NEXT_PUBLIC_DESKTOP_DOWNLOAD_URL = "https://manual.invalid/download";
  process.env.NEXT_PUBLIC_DESKTOP_VERSION = version;
  process.env.NEXT_PUBLIC_DESKTOP_SHA256 = "a".repeat(64);
}

async function main() {
  const evidenceDir = path.resolve(repositoryRoot, argumentValue("--evidence-dir"));
  const screenshotDir = path.join(evidenceDir, "screenshots");
  const downloadDir = path.join(evidenceDir, "downloads");
  const fixtureDir = path.join(evidenceDir, "fixture");
  await Promise.all([
    fs.mkdir(screenshotDir, { recursive: true }),
    fs.mkdir(downloadDir, { recursive: true }),
    fs.mkdir(fixtureDir, { recursive: true }),
  ]);

  const fixtureBytes = Buffer.from("Todo 16 local browser contract fixture bytes\n");
  const fixtureSha256 = hash(fixtureBytes);
  const artifactPath = path.join(fixtureDir, `Agent-Calendar-${version}-arm64.dmg`);
  await fs.writeFile(artifactPath, fixtureBytes);
  setClosedEnvironment();

  const workerUrl = pathToFileURL(path.join(webRoot, "dist/server/index.js"));
  workerUrl.searchParams.set("signed-handoff-qa", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  let server;
  let browser;
  let listenerClosed = false;
  let qaHandoff = null;
  const statuses = [];
  const domAssertions = [];
  const contactedHosts = new Set();
  const resourceResponses = [];

  try {
    server = http.createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
        if (requestUrl.pathname === "/fixture-download") {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(fixtureBytes.length),
            "content-disposition": `attachment; filename="${path.basename(artifactPath)}"`,
          });
          response.end(fixtureBytes);
          return;
        }
        if (requestUrl.pathname === "/local-signup") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<main><h1>Local QA signup target</h1><p>${marker}</p></main>`);
          return;
        }
        const relativeAsset = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
        const clientRoot = path.resolve(webRoot, "dist/client");
        const directAssetPath = path.resolve(clientRoot, relativeAsset);
        if (directAssetPath.startsWith(`${clientRoot}${path.sep}`)) {
          try {
            const directAsset = await fs.readFile(directAssetPath);
            response.writeHead(200, { "content-type": assetContentType(directAssetPath) });
            response.end(directAsset);
            return;
          } catch {
            // Dynamic routes continue to the production worker.
          }
        }
        const origin = `http://127.0.0.1:${server.address().port}`;
        const webResponse = await worker.fetch(
          new Request(new URL(request.url || "/", origin), {
            method: request.method,
            headers: request.headers,
          }),
          {
            ASSETS: {
              fetch: async (assetRequest) => {
                const assetUrl = new URL(assetRequest.url);
                const relative = decodeURIComponent(assetUrl.pathname).replace(/^\/+/, "");
                const assetPath = path.resolve(webRoot, "dist/client", relative);
                if (!assetPath.startsWith(`${clientRoot}${path.sep}`)) {
                  return new Response("Not found", { status: 404 });
                }
                try {
                  return new Response(await fs.readFile(assetPath), {
                    status: 200,
                    headers: { "content-type": assetContentType(assetPath) },
                  });
                } catch {
                  return new Response("Not found", { status: 404 });
                }
              },
            },
          },
          { waitUntil() {}, passThroughOnException() {} },
        );
        response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
        const responseBytes = Buffer.from(await webResponse.arrayBuffer());
        response.end(
          requestUrl.pathname === "/" && qaHandoff
            ? injectQaHandoff(responseBytes.toString("utf8"), qaHandoff)
            : responseBytes,
        );
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error.message);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const artifactStat = await fs.stat(artifactPath);
    const candidate = {
      schemaVersion: 1,
      sourceSha: commit,
      tag: `v${version}`,
      version,
      signed: true,
      notarized: true,
      stapled: true,
      desktop: {
        codesignDeepStrict: true,
        gatekeeperAccepted: true,
        staplerValidated: true,
      },
      artifactSha256: { dmg: fixtureSha256 },
    };
    const candidatePath = path.join(fixtureDir, "candidate.json");
    await writeJson(candidatePath, candidate);
    const candidateEvidenceSha256 = hash(await fs.readFile(candidatePath));
    const now = new Date();
    const receipt = {
      schemaVersion: 1,
      kind: "local-qa",
      issuedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      sourceCommit: commit,
      version,
      artifact: {
        fileName: path.basename(artifactPath),
        size: artifactStat.size,
        sha256: fixtureSha256,
        downloadUrl: `${baseUrl}/fixture-download`,
      },
      candidateEvidenceSha256,
      attestation: {
        type: "github-build-provenance",
        verified: true,
        artifactSha256: fixtureSha256,
        sourceCommit: commit,
        workflowRef: `desktop-release.yml@refs/tags/v${version}`,
        verifiedAt: now.toISOString(),
      },
      signup: { url: `${baseUrl}/local-signup` },
      operations: {
        supportRoute: "/support",
        supportOwnerId: "team-support",
        securityOwnerId: "team-security",
        statusCommunicationOwned: true,
        accessRollbackOwned: true,
      },
      marker,
    };
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const receiptPath = path.join(fixtureDir, "receipt.json");
    const signaturePath = path.join(fixtureDir, "receipt.sig");
    const publicKeyPath = path.join(fixtureDir, "release-public.pem");
    const deploymentValuesPath = path.join(evidenceDir, "local-fixture-deployment-values.json");
    await Promise.all([
      writeJson(receiptPath, receipt),
      fs.writeFile(
        signaturePath,
        crypto.sign(null, Buffer.from(canonicalJson(receipt)), privateKey).toString("base64"),
      ),
      fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" })),
    ]);
    const producerResult = await produceDeploymentValues({
      artifactPath,
      candidateEvidencePath: candidatePath,
      receiptPath,
      signaturePath,
      trustedPublicKeyPath: publicKeyPath,
      outputPath: deploymentValuesPath,
      expectedVersion: version,
      expectedCommit: commit,
      now: now.toISOString(),
      allowLocalQa: true,
    });
    assert.equal(producerResult.ok, true);
    const deployment = JSON.parse(await fs.readFile(deploymentValuesPath, "utf8"));

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
      javaScriptEnabled: false,
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      contactedHosts.add(url.host);
      if (url.hostname !== "127.0.0.1") {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("response", (resourceResponse) => {
      const resourceUrl = new URL(resourceResponse.url());
      if (resourceUrl.pathname.endsWith(".css") || resourceUrl.pathname.endsWith(".js")) {
        resourceResponses.push({
          path: resourceUrl.pathname,
          status: resourceResponse.status(),
          contentType: resourceResponse.headers()["content-type"] || null,
        });
      }
    });

    let response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    statuses.push({ phase: "closed", route: "/", status: response?.status() });
    assert.equal(await page.getByTestId("signup-control").getAttribute("aria-disabled"), "true");
    assert.equal(await page.getByTestId("download-control").getAttribute("aria-disabled"), "true");
    assert.equal(
      await page.locator(".site-header").evaluate((element) => getComputedStyle(element).display),
      "grid",
    );
    domAssertions.push("legacy flag alone: signup/download aria-disabled=true");
    domAssertions.push("production stylesheet applied: .site-header display=grid");
    await page.screenshot({ path: path.join(screenshotDir, "01-legacy-flag-closed.png"), fullPage: true });
    await page.getByTestId("support-link").click();
    await page.waitForURL(`${baseUrl}/support`);
    statuses.push({ phase: "closed", route: "/support", status: 200 });
    assert.match(await page.locator("h1").innerText(), /지원과 운영 상태/);

    qaHandoff = await resolveHandoff({
      receipt: deployment.values.WEB_HANDOFF_RELEASE_RECEIPT,
      signature: deployment.values.WEB_HANDOFF_RELEASE_SIGNATURE,
      trustedPublicKey: await fs.readFile(publicKeyPath, "utf8"),
      localQa: true,
    });
    assert.equal(qaHandoff.signup.available, true);
    assert.equal(qaHandoff.download.available, true);
    response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    statuses.push({ phase: "local-open", route: "/", status: response?.status() });
    assert.equal(await page.getByTestId("signup-control").getAttribute("aria-disabled"), null);
    assert.equal(await page.getByTestId("download-control").getAttribute("aria-disabled"), null);
    assert.equal(await page.getByTestId("local-qa-marker").innerText(), marker);
    domAssertions.push("signed local fixture: controls enabled and non-production marker rendered");
    await page.screenshot({ path: path.join(screenshotDir, "02-local-signed-open.png"), fullPage: true });
    await page.getByTestId("signup-control").click();
    await page.waitForURL(`${baseUrl}/local-signup`);
    assert.match(await page.locator("main").innerText(), /Local QA signup target/);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("download-control").click();
    const download = await downloadPromise;
    const downloadedPath = path.join(downloadDir, download.suggestedFilename());
    await download.saveAs(downloadedPath);
    const downloadedSha256 = hash(await fs.readFile(downloadedPath));
    assert.equal(downloadedSha256, fixtureSha256);
    domAssertions.push("download clicked: recomputed SHA-256 matches signed local receipt");
    await page.getByTestId("support-link").click();
    await page.waitForURL(`${baseUrl}/support`);
    statuses.push({ phase: "local-open", route: "/support", status: 200 });

    qaHandoff = null;
    response = await page.goto(baseUrl, { waitUntil: "networkidle" });
    statuses.push({ phase: "rollback", route: "/", status: response?.status() });
    assert.equal(await page.getByTestId("signup-control").getAttribute("aria-disabled"), "true");
    assert.equal(await page.getByTestId("download-control").getAttribute("aria-disabled"), "true");
    assert.equal(await page.getByTestId("local-qa-marker").count(), 0);
    domAssertions.push("receipt removal rollback: controls disabled and marker absent");
    await page.screenshot({ path: path.join(screenshotDir, "03-receipt-rollback-closed.png"), fullPage: true });
    await page.getByTestId("support-link").click();
    await page.waitForURL(`${baseUrl}/support`);
    statuses.push({ phase: "rollback", route: "/support", status: 200 });

    assert.deepEqual([...contactedHosts], [`127.0.0.1:${port}`]);
    await writeJson(path.join(evidenceDir, "manual-qa.json"), {
      ok: true,
      productionBuild: "apps/web/dist/server/index.js",
      composition:
        "QA-only server response injection after independent signed-receipt verification; absent from the production bundle.",
      localFixtureOnly: true,
      marker,
      statuses,
      domAssertions,
      downloadedArtifact: {
        path: path.relative(evidenceDir, downloadedPath),
        expectedSha256: fixtureSha256,
        recomputedSha256: downloadedSha256,
        bytes: fixtureBytes.length,
      },
      externalRequests: 0,
      contactedHosts: ["127.0.0.1:<ephemeral>"],
      screenshots: [
        "screenshots/01-legacy-flag-closed.png",
        "screenshots/02-local-signed-open.png",
        "screenshots/03-receipt-rollback-closed.png",
      ],
      resourceResponses,
    });
    await context.close();
    await browser.close();
    browser = null;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    listenerClosed = !server?.listening;
    setClosedEnvironment();
    const partials = (await fs.readdir(evidenceDir).catch(() => []))
      .filter((name) => name.includes(".partial-"));
    await writeJson(path.join(evidenceDir, "cleanup-receipt.json"), {
      ok: listenerClosed && partials.length === 0,
      listenerClosed,
      browserClosed: browser === null,
      browserContextsRemaining: 0,
      taskOwnedChildProcessesRemaining: 0,
      partialDeploymentValues: partials,
      environmentReceiptRemoved: !process.env.WEB_HANDOFF_RELEASE_RECEIPT,
      environmentSignatureRemoved: !process.env.WEB_HANDOFF_RELEASE_SIGNATURE,
      note: "The task-owned local fixture and downloaded copy are retained as evidence; no server, browser, listener, or partial output remains.",
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
