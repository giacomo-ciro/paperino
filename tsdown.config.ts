import { defineConfig } from "tsdown";

export default defineConfig({
    banner: "#!/usr/bin/env node", // prepend to the output
    clean: true, // remove content of the outdir before building
    outDir: "dist",
    dts: false, // skip .d.ts declaration file (we only ship a CLI)
    entry: ["src/cli.ts"],
    copy: ["src/bootstrap-config.toml"], // ship the config template alongside the build
})