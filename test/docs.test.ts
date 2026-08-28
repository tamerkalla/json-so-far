/// <reference types="node" />
// This file alone needs Node's ambient types: the project's tsconfig keeps
// "types": ["vitest/globals"] so `src` stays environment-agnostic (Node,
// browsers, workers, edge), and this reference opts only this file in.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Example {
  lang: "bash";
  code: string;
  expected: string;
}

// Finds every (code block, claimed output) pair in VERIFY.md: a fenced
// ```bash block, then a line reading "Output:"/"Expected output:", then a
// fenced ```text block holding the exact text the code is claimed to print.
// Neither captured group may itself contain a "```" line.
function extractExamples(markdown: string): Example[] {
  const re =
    /```(bash)\n((?:(?!```)[\s\S])*?)\n```\n\n(?:Output|Expected output):\n\n```text\n((?:(?!```)[\s\S])*?)\n```/g;
  const examples: Example[] = [];
  for (const m of markdown.matchAll(re)) {
    examples.push({ lang: m[1] as "bash", code: m[2] as string, expected: m[3] as string });
  }
  return examples;
}

describe("README.md structure", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const hook = "**A best-effort parser for JSON that hasn't finished arriving.**";

  test("opens with the fixed hook", () => {
    expect(readme.startsWith(`# json-so-far\n\n${hook}\n`)).toBe(true);
  });

  test("the badge row appears character-for-character, immediately after the hook", () => {
    const badges = [
      "[![build](https://github.com/tamerkalla/json-so-far/actions/workflows/release.yml/badge.svg)](https://github.com/tamerkalla/json-so-far/actions/workflows/release.yml)",
      "[![npm](https://img.shields.io/npm/v/json-so-far.svg)](https://www.npmjs.com/package/json-so-far)",
      "[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)",
      "[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen.svg)](https://www.npmjs.com/package/json-so-far)",
    ].join("\n");
    const badgeIndex = readme.indexOf(badges);
    const hookIndex = readme.indexOf(hook);
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeGreaterThan(hookIndex);
    expect(readme.slice(hookIndex + hook.length, badgeIndex)).toBe("\n\n");
  });

  test("keeps the mutation-score badge as a fifth line, and drops the zero-dependencies badge", () => {
    expect(readme).toMatch(/\[!\[mutation score\]/);
    expect(readme).not.toMatch(/zero dependencies/);
    const badges = readme.slice(readme.indexOf("[![build]"), readme.indexOf("An LLM streams"));
    const lines = badges.trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toMatch(/^\[!\[mutation score\]/);
  });

  test("links to VERIFY.md", () => {
    expect(readme).toMatch(/VERIFY\.md/);
  });
});

describe("every code example in VERIFY.md is executed and its output matches", () => {
  const verify = readFileSync(join(ROOT, "VERIFY.md"), "utf8");
  const examples = extractExamples(verify);

  test("does not require this repository to be checked out", () => {
    expect(verify.replace(/\s+/g, " ")).toMatch(/does not require this repository to be checked out/);
  });

  test("installs by the latest tag into a clean directory", () => {
    expect(verify).toMatch(/npm install json-so-far@latest/);
    expect(verify).toMatch(/mkdir -p/);
  });

  test("at least one example was found", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  let tarballPath: string;
  let packDir: string;

  beforeAll(() => {
    packDir = mkdtempSync(join(tmpdir(), "json-so-far-verify-pack-"));
    const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(pack.status).toBe(0);
    const tarballName = pack.stdout.trim().split("\n").pop()!.trim();
    tarballPath = join(packDir, tarballName);
    expect(existsSync(tarballPath)).toBe(true);
  }, 120_000);

  afterAll(() => {
    rmSync(packDir, { recursive: true, force: true });
  });

  for (const [i, example] of examples.entries()) {
    if (!example.code.includes("npm install json-so-far@latest")) continue;
    test(`example ${i + 1} (installed from the published tarball) reproduces the claimed output`, () => {
      const dir = mkdtempSync(join(tmpdir(), "json-so-far-verify-run-"));
      try {
        // The doc installs from the registry; the test instead unpacks the
        // tarball this repository just built into node_modules, reproducing
        // the installed layout without `npm install` (this package has zero
        // dependencies, so no other node_modules content is needed) — a
        // fresh `npm install` would need the network, and no test may reach it.
        const replacement = [
          "mkdir -p node_modules",
          `tar -xzf ${JSON.stringify(tarballPath)} -C node_modules`,
          "mv node_modules/package node_modules/json-so-far",
        ].join("\n");
        const prepared = example.code.replace(
          /npm init -y >\/dev\/null 2>&1\nnpm install json-so-far@latest >\/dev\/null 2>&1/,
          replacement,
        );
        const script = join(dir, "run.sh");
        writeFileSync(script, prepared);
        const result = spawnSync("bash", [script], { cwd: dir, encoding: "utf8" });
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toBe(example.expected.trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
