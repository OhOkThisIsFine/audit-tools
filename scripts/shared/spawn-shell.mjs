// The win32 spawn shim — ONE home for every script that spawns a package-manager
// shim or a `.bin` wrapper.
//
// `.cmd` / `.bat` wrappers only resolve through the command shell on win32
// (CLAUDE.md "Windows-aware"). This pair used to exist as five byte-identical
// copies across `scripts/`; a copy is a place a fix can miss.

export function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export function resolveSpawn(command, args) {
  if (!(process.platform === "win32" && /\.(cmd|bat)$/iu.test(command))) {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

// Render a command for a log line or an error message: quote only the parts
// that need it, so the result is copy-pasteable.
export function formatCommand(command, args) {
  return [command, ...args]
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}
