import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { InputOptions } from "@actions/core";
import type { AIAgent } from "../src/ai/ai-agent";
import type { ChangedFile } from "../src/types/constants";
import { mockChangedFiles, mockFileContent, mockInputs } from "./mocks";

// Define the InputProcessor type
interface InputProcessorType {
	create(): Promise<InputProcessorInstance>;
}

interface InputProcessorInstance {
	processInputs(): Promise<InputProcessorInstance>;
	getAIAgent(): AIAgent;
	getFilteredDiffs: ChangedFile[];
}

// Define the type for our test inputs
type TestInputs = Record<string, string>;

// Ensure mock inputs have all required values
const testInputs: TestInputs = {
	...mockInputs,
	anthropic_api_key: "mock-anthropic-api-key",
	google_api_key: "mock-google-api-key",
};

// Create mock factory functions to ensure fresh mocks for each test
const createCoreMocks = () => ({
	getInput: mock((name: string, options?: InputOptions) => {
		// Return the mock input value or empty string
		return testInputs[name] || "";
	}),
	setOutput: mock(),
	setFailed: mock(),
	info: mock(),
	warning: mock(),
	error: mock(),
	debug: mock(),
});

const createGitHubAPIMocks = () => ({
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
});

describe("InputProcessor", () => {
	let InputProcessor: InputProcessorType;
	let mockCoreModule: ReturnType<typeof createCoreMocks>;
	let mockGitHubAPI: ReturnType<typeof createGitHubAPIMocks>;
	let MockGitHubAPIConstructor: ReturnType<
		typeof mock<() => typeof mockGitHubAPI>
	>;

	beforeEach(async () => {
		// Set up environment variables for testing
		process.env.GITHUB_TOKEN = "mock-github-token";

		// Create fresh mocks for each test
		mockCoreModule = createCoreMocks();
		mockGitHubAPI = createGitHubAPIMocks();
		MockGitHubAPIConstructor = mock(() => mockGitHubAPI);

		// Use Bun's mock.module to mock the modules
		mock.module("@actions/core", () => mockCoreModule);
		mock.module("../src/github/github-api", () => ({
			GitHubAPI: MockGitHubAPIConstructor,
		}));

		// Import the InputProcessor after mocking
		try {
			// Use a dynamic import with the actual import function
			const module = await import("../src/config/input-processor");
			InputProcessor = module.InputProcessor;
		} catch (error) {
			console.error("Error importing InputProcessor:", error);
		}
	});

	afterEach(() => {
		// Clean up environment variables
		process.env.GITHUB_TOKEN = "";
	});

	it("should create an InputProcessor instance", async () => {
		const inputProcessor = await InputProcessor.create();
		expect(inputProcessor).toBeDefined();
		expect(mockCoreModule.getInput.mock.calls.length).toBeGreaterThan(0);
	});

	it("should process inputs successfully", async () => {
		const inputProcessor = await InputProcessor.create();
		await inputProcessor.processInputs();

		expect(mockGitHubAPI.getPullRequest.mock.calls.length).toBeGreaterThan(0);
		expect(
			mockGitHubAPI.getFilesBetweenCommits.mock.calls.length,
		).toBeGreaterThan(0);
		expect(inputProcessor.getFilteredDiffs.length).toBeGreaterThan(0);
	});

	it("should get the correct AI agent based on provider", async () => {
		const inputProcessor = await InputProcessor.create();
		await inputProcessor.processInputs();

		const aiAgent = inputProcessor.getAIAgent();
		expect(aiAgent).toBeDefined();

		// Check if the correct AI agent was created based on the provider
		if (testInputs.ai_provider === "anthropic") {
			expect(aiAgent.constructor.name).toContain("Anthropic");
		} else if (testInputs.ai_provider === "google") {
			expect(aiAgent.constructor.name).toContain("Google");
		}
	});

	it("should filter files based on extensions and paths", async () => {
		// Set up specific include/exclude patterns
		const originalIncludeExtensions = testInputs.include_extensions;
		const originalExcludeExtensions = testInputs.exclude_extensions;

		testInputs.include_extensions = ".ts,.tsx";
		testInputs.exclude_extensions = ".test.ts";

		const inputProcessor = await InputProcessor.create();
		await inputProcessor.processInputs();

		// All our mock files are .ts files in src/, so they should be included
		expect(inputProcessor.getFilteredDiffs.length).toBe(
			mockChangedFiles.length,
		);

		// Reset the mock inputs
		testInputs.include_extensions = originalIncludeExtensions;
		testInputs.exclude_extensions = originalExcludeExtensions;
	});

	it("should demonstrate how to use Bun mocks", () => {
		// Create a fresh mock for this test
		const testMock = mock(() => "test");

		// Call the mock
		testMock();
		expect(testMock.mock.calls.length).toBe(1);

		// Create a new mock to demonstrate it starts with 0 calls
		const newMock = mock(() => "new");
		expect(newMock.mock.calls.length).toBe(0);
	});

	it("should check mock call arguments", () => {
		// Call the mock with specific arguments
		mockCoreModule.getInput("repo");
		mockCoreModule.getInput("owner");

		// Check the arguments
		expect(mockCoreModule.getInput.mock.calls[0][0]).toBe("repo");
		expect(mockCoreModule.getInput.mock.calls[1][0]).toBe("owner");
	});

	it("should mock async functions", async () => {
		// Call the async mock
		const result = await mockGitHubAPI.getPullRequest();

		// Check the result
		expect(result).toEqual({
			head: { sha: "mock-head-sha" },
			base: { sha: "mock-base-sha" },
		});

		// Check that the mock was called
		expect(mockGitHubAPI.getPullRequest.mock.calls.length).toBe(1);
	});
});
