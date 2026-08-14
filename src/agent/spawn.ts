import type { spawn } from "node:child_process";

/**
 * SIGTERM the child's whole process group, so an agent CLI's own children die with it.
 * Both agents spawn detached, which makes the child a group leader.
 */
export function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child if it was not started as a process group.
    }
  }
  child.kill("SIGTERM");
}
