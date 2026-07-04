import * as esbuild from "npm:esbuild@0.25.2";

const watch = Deno.args.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["assets/css/style.css"],
  bundle: true,
  minify: true,
  outfile: "public/css/style.css",
});

if (watch) {
  await ctx.watch();
  console.log("[build-css] watching assets/css/");
} else {
  const result = await ctx.rebuild();
  const warnings = result.warnings.length;
  console.log(`[build-css] built public/css/style.css${warnings ? ` (${warnings} warnings)` : ""}`);
  await ctx.dispose();
}
