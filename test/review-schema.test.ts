import { describe, expect, it } from "bun:test";
import { z } from "zod";

// Import the schema from a separate file to test it
const ReviewResultSchema = z.object({
	summary: z.string().min(1, "Summary is required"),
	filesReviewed: z.array(z.string()),
	issuesFound: z.number().int().nonnegative(),
	recommendations: z.array(z.string()),
	severity: z.enum(["low", "medium", "high"]).optional(),
});

type ReviewResult = z.infer<typeof ReviewResultSchema>;

describe("ReviewResultSchema", () => {
	it("should validate valid review results", () => {
		const validReviewResult: ReviewResult = {
			summary: "This is a summary of the code review",
			filesReviewed: [
				"src/config/input-processor.ts",
				"src/ai/anthropic-agent.ts",
			],
			issuesFound: 5,
			recommendations: [
				"Fix type safety issues in the InputProcessor class",
				"Add error handling for API calls",
				"Improve documentation",
			],
			severity: "medium",
		};

		const result = ReviewResultSchema.safeParse(validReviewResult);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual(validReviewResult);
		}
	});

	it("should validate review results without severity", () => {
		const reviewResultWithoutSeverity = {
			summary: "This is a summary of the code review",
			filesReviewed: [
				"src/config/input-processor.ts",
				"src/ai/anthropic-agent.ts",
			],
			issuesFound: 5,
			recommendations: [
				"Fix type safety issues in the InputProcessor class",
				"Add error handling for API calls",
				"Improve documentation",
			],
		};

		const result = ReviewResultSchema.safeParse(reviewResultWithoutSeverity);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.severity).toBeUndefined();
		}
	});

	it("should reject invalid review results", () => {
		const invalidReviewResult = {
			summary: "",
			filesReviewed: [],
			issuesFound: -1,
			recommendations: [],
			severity: "critical",
		};

		const result = ReviewResultSchema.safeParse(invalidReviewResult);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.errors.length).toBeGreaterThan(0);
		}
	});

	it("should reject review results with missing required fields", () => {
		const incompleteReviewResult = {
			summary: "This is a summary of the code review",
			filesReviewed: ["src/config/input-processor.ts"],
			// Missing issuesFound and recommendations
		};

		const result = ReviewResultSchema.safeParse(incompleteReviewResult);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.errors.length).toBeGreaterThan(0);
		}
	});

	it("should validate review results with zero issues", () => {
		const reviewResultWithZeroIssues = {
			summary: "No issues found in the code review",
			filesReviewed: [
				"src/config/input-processor.ts",
				"src/ai/anthropic-agent.ts",
			],
			issuesFound: 0,
			recommendations: ["Keep up the good work"],
			severity: "low",
		};

		const result = ReviewResultSchema.safeParse(reviewResultWithZeroIssues);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.issuesFound).toBe(0);
		}
	});
});
