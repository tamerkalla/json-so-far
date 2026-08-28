/// <reference types="node" />
// This file alone needs Node's ambient types: the project's tsconfig keeps
// "types": ["vitest/globals"] so `src` stays environment-agnostic (Node,
// browsers, workers, edge), and this reference opts only this file in.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Workflow {
  name: string;
  // YAML 1.1 (unlike the 1.2 core schema this file is parsed with) resolves a
  // bare `on:` key as the boolean `true`, not the string "on" — a parser
  // using that dialect would silently look up a key that isn't there. The
  // presence check below guards against exactly that class of mistake.
  on?: Record<string, unknown>;
  jobs: Record<string, { steps: Step[]; permissions?: Record<string, string> }>;
}

function loadWorkflow(name: string): Workflow {
  const text = readFileSync(`${ROOT}/.github/workflows/${name}`, "utf8");
  return YAML.parse(text) as Workflow;
}

describe(".github/workflows/ci.yml", () => {
  const ci = loadWorkflow("ci.yml");

  test("the trigger key was actually found", () => {
    expect(Object.prototype.hasOwnProperty.call(ci, "on")).toBe(true);
    expect(ci.on).toBeTruthy();
  });

  test("does not trigger on pushes to main, but does on pull_request and dispatch", () => {
    const on = ci.on as {
      push: { "branches-ignore": string[] };
      pull_request: unknown;
      workflow_dispatch: unknown;
    };
    expect(on.push["branches-ignore"]).toEqual(["main"]);
    expect("pull_request" in on).toBe(true);
    expect("workflow_dispatch" in on).toBe(true);
  });

  test("the test job runs install, typecheck, test, build and the entry-point smoke check, in order", () => {
    const steps = ci.jobs.test!.steps;
    const runSteps = steps.filter((s) => typeof s.run === "string").map((s) => s.run);
    expect(runSteps).toEqual(["npm ci", "npm run typecheck", "npm test", "npm run build", "node scripts/smoke.mjs"]);
  });
});

describe(".github/workflows/release.yml", () => {
  const release = loadWorkflow("release.yml");

  test("the trigger key was actually found", () => {
    expect(Object.prototype.hasOwnProperty.call(release, "on")).toBe(true);
    expect(release.on).toBeTruthy();
  });

  test("triggers on push to main and on workflow_dispatch with bump/auth choices", () => {
    const on = release.on as {
      push: { branches: string[] };
      workflow_dispatch: {
        inputs: Record<string, { type: string; default: string; options: string[] } | undefined>;
      };
    };
    expect(on.push.branches).toEqual(["main"]);
    expect(on.workflow_dispatch.inputs["bump"]?.options).toEqual(["patch", "minor", "major"]);
    expect(on.workflow_dispatch.inputs["bump"]?.default).toBe("patch");
    expect(on.workflow_dispatch.inputs["auth"]?.options).toEqual(["oidc", "token"]);
    expect(on.workflow_dispatch.inputs["auth"]?.default).toBe("oidc");
  });

  test("never triggers on a tag", () => {
    const on = release.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(["push", "workflow_dispatch"]);
    expect(Object.prototype.hasOwnProperty.call(on["push"] as object, "tags")).toBe(false);
  });

  test("the publish job requests contents:write and id-token:write", () => {
    const permissions = release.jobs["publish"]?.permissions;
    expect(permissions).toEqual({ contents: "write", "id-token": "write" });
  });

  test("a push only releases when the version still reads 0.0.0", () => {
    const plan = release.jobs["publish"]?.steps.find((s) => s.name === "Plan");
    expect(plan?.run ?? "").toContain('"$v" = "0.0.0"');
    expect(plan?.run ?? "").toContain("release=false");
  });

  test("the bump step's version output is read from package.json, never captured from npm version's stdout", () => {
    // npm version prints the new version WITH a leading "v" ("v0.2.2"). The
    // release step does `gh release create "v${{ steps.bump.outputs.version }}"`,
    // so if that output is ever npm version's own stdout instead of a fresh
    // read of package.json, the tag and release title come out "vv0.2.2".
    const bump = release.jobs["publish"]?.steps.find((s) => s.name === "Bump version and tag");
    const run = bump?.run ?? "";
    expect(run).toMatch(/version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
    expect(run).not.toMatch(/version="\$\(npm version/);
  });

  test("never publishes without first verifying: test precedes any publish step", () => {
    const steps = release.jobs["publish"]?.steps ?? [];
    const names = steps.map((s) => s.name ?? s.run ?? s.uses ?? "");
    const testIdx = steps.findIndex((s) => s.run === "npm test");
    const publishIdx = steps.findIndex((s) => (s.name ?? "").startsWith("Publish"));
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThan(testIdx);
    expect(names).toContain("Plan");
  });

  test("publishes before pushing the version commit, and releases last", () => {
    const steps = release.jobs["publish"]?.steps ?? [];
    const publishTokenIdx = steps.findIndex((s) => s.name === "Publish (token)");
    const publishOidcIdx = steps.findIndex((s) => s.name === "Publish (OIDC)");
    const pushIdx = steps.findIndex((s) => s.name === "Push the version commit and tag");
    const releaseIdx = steps.findIndex((s) => s.name === "Create GitHub Release");
    expect(publishTokenIdx).toBeGreaterThanOrEqual(0);
    expect(publishOidcIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeGreaterThan(publishTokenIdx);
    expect(pushIdx).toBeGreaterThan(publishOidcIdx);
    expect(releaseIdx).toBeGreaterThan(pushIdx);
  });

  test("the token publish step carries NODE_AUTH_TOKEN; the OIDC step carries no auth env", () => {
    const steps = release.jobs["publish"]?.steps ?? [];
    const tokenStep = steps.find((s) => s.name === "Publish (token)")!;
    const oidcStep = steps.find((s) => s.name === "Publish (OIDC)")!;
    expect(tokenStep.env?.["NODE_AUTH_TOKEN"]).toBeTruthy();
    expect(oidcStep.env).toBeUndefined();
  });

  test("setup-node is configured twice, gated on auth, and only the token path sets a registry-url", () => {
    const steps = release.jobs["publish"]?.steps ?? [];
    const setupSteps = steps.filter((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(setupSteps.length).toBe(2);
    const tokenSetup = setupSteps.find((s) => s.if?.includes("== 'token'"));
    const otherSetup = setupSteps.find((s) => s.if?.includes("!= 'token'"));
    expect(tokenSetup?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    expect(otherSetup?.with?.["registry-url"]).toBeUndefined();
  });
});
