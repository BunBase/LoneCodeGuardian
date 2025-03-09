import { mock } from "bun:test";
import type { ChangedFile } from "../src/types/constants";

/**
 * Mock GitHub Action inputs
 */
export const mockInputs: Record<string, string> = {
	repo: "test-repo",
	owner: "test-owner",
	pr_number: "123",
	ai_provider: "anthropic", // or 'google'
	anthropic_api_key: process.env.ANTHROPIC_API_KEY || "",
	anthropic_model: "claude-3-sonnet-20240229",
	google_api_key: process.env.GOOGLE_API_KEY || "",
	google_model: "gemini-1.5-pro-latest",
	fail_action_if_review_failed: "false",
	include_extensions: ".ts,.tsx,.js,.jsx",
	exclude_extensions: ".test.ts,.spec.ts",
	include_paths: "src/",
	exclude_paths: "node_modules/,dist/",
};

/**
 * Mock GitHub API responses
 */
export const mockChangedFiles: ChangedFile[] = [
	{
		filename: "src/config/input-processor.ts",
		status: "modified",
		additions: 100,
		deletions: 50,
		changes: 150,
		patch:
			'@@ -1,10 +1,15 @@\n import * as core from "@actions/core";\n+import { z } from "zod";\n import type { AIAgent } from "../ai/ai-agent";',
	},
	{
		filename: "src/ai/anthropic-agent.ts",
		status: "modified",
		additions: 50,
		deletions: 20,
		changes: 70,
		patch:
			'@@ -1,10 +1,15 @@\n import * as core from "@actions/core";\n import { createAnthropic } from "@ai-sdk/anthropic";\n-import { generateText } from "ai";\n+import { generateText, generateObject } from "ai";\n+import { z } from "zod";',
	},
];

/**
 * Mock file content
 */
export const mockFileContent = `
// This is a mock file content for testing
import * as core from "@actions/core";
import { z } from "zod";

/**
 * Example function
 */
function example() {
  return "Hello, world!";
}

export default example;
`;

// Mock modules for testing
export const mockCore = {
	getInput: mock((name: string) => mockInputs[name] || ""),
	setOutput: mock(),
	setFailed: mock(),
	info: mock(),
	warning: mock(),
	error: mock(),
	debug: mock(),
};

export const mockGitHubAPI = {
	getPullRequest: mock(() =>
		Promise.resolve({
			head: { sha: "mock-head-sha" },
			base: { sha: "mock-base-sha" },
		}),
	),
	listPRComments: mock(() => Promise.resolve([])),
	getFilesBetweenCommits: mock(() => Promise.resolve(mockChangedFiles)),
	getContent: mock(() => Promise.resolve(mockFileContent)),
	createReviewComment: mock(() => Promise.resolve({})),
	createPRComment: mock(() => Promise.resolve({})),
};

// Mock GitHubAPI class constructor
export const MockGitHubAPIClass = mock(() => mockGitHubAPI);

/**
 * Setup mocks for testing - this function is called before running tests
 * Note: In a real implementation, you would use Bun's mocking capabilities
 * to properly mock the modules, but for this example we'll use a simpler approach
 */
export function setupMocks() {
	// The actual mocking is done in local-test.ts
	console.log("🔧 Setting up mocks for testing...");
}
