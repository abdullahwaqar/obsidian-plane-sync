// Bundles the sticky sync tests with Obsidian replaced by a small mock, then runs them.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import esbuild from "esbuild";

mkdirSync(".test-build", { recursive: true });
const suites = ["stickySync", "workItems"];
for (const name of suites)
{
    await esbuild.build({
        entryPoints: [`test/${name}.harness.ts`],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: `.test-build/${name}.test.mjs`,
        alias: { obsidian: "./test/mocks/obsidian.ts" },
        logLevel: "warning",
    });
}
execFileSync(process.execPath, ["--test", ...suites.map((n) => `.test-build/${n}.test.mjs`)], { stdio: "inherit" });
