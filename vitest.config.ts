import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Claude Code keeps git worktrees in .claude/worktrees/. Their copies of the tests are not ours.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
