import browserSync from "npm:browser-sync@3";

const port = Number(Deno.env.get("BROWSER_SYNC_PORT") ?? 3000);

// deno-lint-ignore no-explicit-any
const bs = (browserSync as any).create("esp32-workbench");

bs.init({
  port,
  open: false,
  notify: false,
  ghostMode: false,
  ui: false,
  reloadDelay: 150,
  files: [
    "public/css/**/*.css",
    "public/*.js",
  ],
  logLevel: "info",
  logPrefix: "BS",
});
