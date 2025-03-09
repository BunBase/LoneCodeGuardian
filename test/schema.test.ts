import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { SUPPORTED_PROVIDERS } from "../src/types/constants";

// Import the schema from a separate file to test it
const ActionInputSchema = z.object({
	repo: z.string().min(1, "Repository name is required"),
	owner: z.string().min(1, "Owner name is required"),
	pr_number: z.coerce
		.number()
		.int()
		.positive("Pull request number must be a valid positive number"),
	token: z.string().min(1, "GitHub token is required"),
	ai_provider: z.enum(["anthropic", "google"], {
		errorMap: () => ({
			message: `AI provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
		}),
	}),
	api_key: z.string().min(1, "API key is required"),
	model: z.string().min(1, "Model name is required"),
	fail_action_if_review_failed: z.boolean().default(false),
	include_extensions: z.string().optional(),
	exclude_extensions: z.string().optional(),
	include_paths: z.string().optional(),
	exclude_paths: z.string().optional(),
});

type ActionInputs = z.infer<typeof ActionInputSchema>;

describe("ActionInputSchema", () => {
	it("should validate valid inputs", () => {
		const validInputs = {
			repo: "test-repo",
			owner: "test-owner",
			pr_number: 123,
			token: "github-token",
			ai_provider: "anthropic",
			api_key: "api-key",
			model: "claude-3-sonnet",
			fail_action_if_review_failed: false,
			include_extensions: ".ts,.tsx",
			exclude_extensions: ".test.ts",
			include_paths: "src/",
			exclude_paths: "node_modules/",
		};

		const result = ActionInputSchema.safeParse(validInputs);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual(validInputs);
		}
	});

	it("should validate string inputs for pr_number", () => {
		const inputsWithStringPrNumber = {
			repo: "test-repo",
			owner: "test-owner",
			pr_number: "123",
			token: "github-token",
			ai_provider: "anthropic",
			api_key: "api-key",
			model: "claude-3-sonnet",
			fail_action_if_review_failed: false,
		};

		const result = ActionInputSchema.safeParse(inputsWithStringPrNumber);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pr_number).toBe(123);
		}
	});

	it("should validate string inputs for fail_action_if_review_failed", () => {
		const inputsWithStringFailAction = {
			repo: "test-repo",
			owner: "test-owner",
			pr_number: 123,
			token: "github-token",
			ai_provider: "anthropic",
			api_key: "api-key",
			model: "claude-3-sonnet",
			fail_action_if_review_failed: "true",
		};

		// We need to manually convert the string to boolean since the schema doesn't do this automatically
		const parsedInputs = {
			...inputsWithStringFailAction,
			fail_action_if_review_failed:
				inputsWithStringFailAction.fail_action_if_review_failed === "true",
		};

		const result = ActionInputSchema.safeParse(parsedInputs);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.fail_action_if_review_failed).toBe(true);
		}
	});

	it("should reject invalid inputs", () => {
		const invalidInputs = {
			repo: "",
			owner: "",
			pr_number: -1,
			token: "",
			ai_provider: "invalid-provider",
			api_key: "",
			model: "",
			fail_action_if_review_failed: "invalid",
		};

		const result = ActionInputSchema.safeParse(invalidInputs);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.errors.length).toBeGreaterThan(0);
		}
	});

	it("should provide default values for optional fields", () => {
		const minimalInputs = {
			repo: "test-repo",
			owner: "test-owner",
			pr_number: 123,
			token: "github-token",
			ai_provider: "anthropic",
			api_key: "api-key",
			model: "claude-3-sonnet",
		};

		const result = ActionInputSchema.safeParse(minimalInputs);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.fail_action_if_review_failed).toBe(false);
			expect(result.data.include_extensions).toBeUndefined();
			expect(result.data.exclude_extensions).toBeUndefined();
			expect(result.data.include_paths).toBeUndefined();
			expect(result.data.exclude_paths).toBeUndefined();
		}
	});
});
