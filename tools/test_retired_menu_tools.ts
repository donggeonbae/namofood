// Exercise real CLI entrypoints with no secret or network permission.
const scripts = [
  "refresh_institutional_menus.ts",
  "rebuild_week_20261005.ts",
  "recover_menu_20261016.ts",
];
for (const file of scripts) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--deny-env",
      "--deny-net",
      new URL(file, import.meta.url).pathname,
      "--apply",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(result.stderr);
  if (
    result.code !== 1 || !stderr.includes("AI 식단 작성은 종료되었습니다") ||
    /NMF_PW required|Requires env access|Requires net access/.test(stderr)
  ) {
    throw new Error(
      `Retired CLI did not fail closed before secrets/network: ${file}: ${stderr}`,
    );
  }
}
console.log(
  "RETIRED_MENU_TOOLS_OK three production CLI writers blocked before secrets/network",
);
