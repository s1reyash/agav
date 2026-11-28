import { execFile } from "node:child_process";
import type { ToolDefinition, ToolResult } from "./types.js";

function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
      });
    });
  });
}

/** Validate that the gh CLI is installed and already authenticated. */
async function checkGh(host?: string): Promise<string | null> {
  const { exitCode, stderr } = await run(host ? ["auth", "status", "--hostname", host] : ["auth", "status"]);
  if (exitCode !== 0) {
    return stderr.includes("not logged")
      ? "GitHub CLI is not authenticated. Run: gh auth login"
      : "GitHub CLI (gh) is not available. Install it from https://cli.github.com";
  }
  return null;
}

export const githubTool: ToolDefinition = {
  schema: {
    name: "github",
    description:
      "Interact with GitHub via the gh CLI. Supports creating/viewing PRs and issues and commenting on them. " +
      "Requires the gh CLI to be installed and authenticated.",
    // Not marked destructive — loop.ts handles non-SAFE_TOOLS confirmation.
    // This avoids blocking read-only operations like view_pr and list_prs.
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["create_pr", "view_pr", "list_prs", "create_issue", "view_issue", "list_issues", "comment_issue", "comment_pr"],
          description: "The GitHub operation to perform.",
        },
        repo: {
          type: "string",
          description: "Target OWNER/REPO or HOST/OWNER/REPO. Omit to use gh repository discovery.",
        },
        title: {
          type: "string",
          description: "Title for the PR or issue (required for create operations).",
        },
        body: {
          type: "string",
          description: "Body/description for the PR or issue, or the comment text (required for comment operations).",
        },
        base: {
          type: "string",
          description: "Base branch for the PR (defaults to the repo default branch).",
        },
        number: {
          type: "number",
          description: "PR or issue number (required for view and comment operations).",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "merged", "all"],
          description: "Filter state for list_prs (open, closed, merged, all) and list_issues (open, closed, all). Defaults to open.",
        },
      },
      required: ["operation"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const op = String(input.operation ?? "");
    const state = input.state;
    if (state !== undefined) {
      if (op !== "list_prs" && op !== "list_issues") {
        return { output: `state filter is only supported for list_prs and list_issues, not ${op}.`, isError: true };
      }
      const allowedStates = op === "list_prs"
        ? ["open", "closed", "merged", "all"]
        : ["open", "closed", "all"];
      if (typeof state !== "string" || !allowedStates.includes(state)) {
        return { output: `Invalid state for ${op}: expected ${allowedStates.join(", ")}.`, isError: true };
      }
    }
    const repo = input.repo;
    const repoMatch = typeof repo === "string"
      ? /^(?:([a-z0-9]+(?:[.-][a-z0-9]+)*)\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/(?!\.{1,2}$)[a-z0-9_.-]+$/i.exec(repo)
      : null;
    if (repo !== undefined && !repoMatch) {
      return { output: "Invalid repo: expected OWNER/REPO or HOST/OWNER/REPO.", isError: true };
    }
    const runInRepo = (args: string[]) => run(typeof repo === "string" ? [...args, "--repo", repo] : args);
    const authErr = await checkGh(repoMatch?.[1]);
    if (authErr) return { output: authErr, isError: true };

    const title = String(input.title ?? "");
    const body = String(input.body ?? "");
    const base = String(input.base ?? "");
    const number = input.number;
    const positiveNumber = typeof number === "number" && Number.isSafeInteger(number) && number > 0;

    switch (op) {
      case "create_pr": {
        if (!title) return { output: "Title is required for creating a PR.", isError: true };
        const args = ["pr", "create", "--title", title];
        if (body) args.push("--body", body);
        if (base) args.push("--base", base);
        const result = await runInRepo(args);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "view_pr": {
        if (!positiveNumber) return { output: "A positive integer PR number is required.", isError: true };
        const result = await runInRepo(["pr", "view", String(number)]);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "list_prs": {
        const args = typeof state === "string" ? ["pr", "list", "--state", state] : ["pr", "list"];
        const emptyMsg = state === "all" ? "No PRs found." : `No ${typeof state === "string" ? state : "open"} PRs.`;
        const result = await runInRepo(args);
        return {
          output: result.stdout || result.stderr || emptyMsg,
          isError: result.exitCode !== 0,
        };
      }

      case "create_issue": {
        if (!title) return { output: "Title is required for creating an issue.", isError: true };
        const args = ["issue", "create", "--title", title];
        if (body) args.push("--body", body);
        const result = await runInRepo(args);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "view_issue": {
        if (!positiveNumber) return { output: "A positive integer issue number is required.", isError: true };
        const result = await runInRepo(["issue", "view", String(number)]);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "list_issues": {
        const args = typeof state === "string" ? ["issue", "list", "--state", state] : ["issue", "list"];
        const emptyMsg = state === "all" ? "No issues found." : `No ${typeof state === "string" ? state : "open"} issues.`;
        const result = await runInRepo(args);
        return {
          output: result.stdout || result.stderr || emptyMsg,
          isError: result.exitCode !== 0,
        };
      }

      case "comment_issue":
      case "comment_pr": {
        const target = input.number;
        if (typeof target !== "number" || !Number.isSafeInteger(target) || target < 1) {
          return { output: "A positive integer issue or PR number is required.", isError: true };
        }
        if (!body.trim()) return { output: "Comment body is required.", isError: true };
        const kind = op === "comment_pr" ? "pr" : "issue";
        const result = await runInRepo([kind, "comment", String(target), "--body", body]);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      default:
        return { output: `Unknown operation: ${op}`, isError: true };
    }
  },
};
