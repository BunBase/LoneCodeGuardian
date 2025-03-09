import * as core from "@actions/core";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { type ChangedFile, TOOL_NAMES } from "../types/constants";
import { AIAgent } from "./ai-agent";

/**
 * Schema for structured review results
 */
const ReviewResultSchema = z.object({
	summary: z.string().min(1, "Summary is required"),
	filesReviewed: z.array(z.string()),
	issuesFound: z.number().int().nonnegative(),
	recommendations: z.array(z.string()),
	severity: z.enum(["low", "medium", "high"]).optional(),
});

type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * AI agent implementation for Anthropic Claude
 */
export class AnthropicAgent extends AIAgent {
	/**
	 * Perform a code review on the provided changed files using Anthropic Claude
	 * @param changedFiles - List of changed files
	 * @returns Review summary
	 */
	async doReview(changedFiles: ChangedFile[]): Promise<string> {
		core.info(
			`Starting code review with Anthropic Claude model: ${this.model}`,
		);
		core.info(`Processing ${changedFiles.length} changed files...`);

		try {
			// Prepare for review
			const simpleChangedFiles = changedFiles.map((file) => ({
				filename: file.filename,
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
				changes: file.changes,
				patch: file.patch,
			}));

			// Maximum retries for API calls
			const maxRetries = 3;
			const initialBackoff = 1000; // 1 second

			// Set up tools for Anthropic
			const tools = this.getTools();

			// Create the Anthropic model with the API key
			const anthropicProvider = createAnthropic({
				apiKey: this.apiKey,
			});

			const model = anthropicProvider(this.model);

			// Initialize variables to capture the review result
			let reviewSummary = "";
			const reviewedFiles = new Set<string>();
			let commentsMade = 0;

			// Create a loop with retries for reliability
			for (let retries = 0; retries < maxRetries; retries++) {
				try {
					// Run the code review
					core.info(
						`Attempt ${retries + 1}/${maxRetries} to generate review using Anthropic model`,
					);

					// Prepare the prompt with context about the changed files
					const prompt = `Here are the changed files in the pull request that need review (${changedFiles.length} files): ${JSON.stringify(simpleChangedFiles, null, 2)}\n\nPlease review these files for issues and provide specific actionable comments where appropriate. If you need to see a file's content, use the get_file_content tool. When you're done reviewing, use the mark_as_done tool with a brief summary.`;

					// Generate the review using the AI model
					const { text, toolCalls } = await generateText({
						model,
						system: this.getSystemPrompt(),
						prompt,
						tools,
						maxTokens: 8000, // Increased token limit for complex reviews
						temperature: 0.2, // Lower temperature for more focused reviews
					});

					// Count files that were reviewed and comments made
					if (toolCalls) {
						for (const call of toolCalls) {
							if (call.toolName === TOOL_NAMES.ADD_REVIEW_COMMENT) {
								commentsMade++;
								reviewedFiles.add(call.args.file_name);
							} else if (call.toolName === TOOL_NAMES.MARK_AS_DONE) {
								reviewSummary = call.args.brief_summary;
							}
						}
					}

					// If no summary was captured from mark_as_done, use the generated text
					if (!reviewSummary) {
						reviewSummary = text;
					}

					// Generate structured review results using generateObject
					try {
						const structuredPrompt = `Based on your review of ${changedFiles.length} files, please provide a structured summary of your findings. Include the number of issues found, the files you reviewed, and any recommendations.`;

						const { object: reviewResult } = await generateObject({
							model,
							schema: ReviewResultSchema,
							prompt: structuredPrompt,
							temperature: 0.1, // Lower temperature for more consistent structured output
						});

						// Log structured review results
						core.info("Structured review results:");
						core.info(`- Summary: ${reviewResult.summary}`);
						core.info(`- Files reviewed: ${reviewResult.filesReviewed.length}`);
						core.info(`- Issues found: ${reviewResult.issuesFound}`);
						core.info(
							`- Severity: ${reviewResult.severity || "not specified"}`,
						);
						core.info(
							`- Recommendations: ${reviewResult.recommendations.length}`,
						);

						// Enhance the review summary with structured data
						reviewSummary = `# Code Review Summary\n\n${reviewResult.summary}\n\n## Details\n\n- **Files Reviewed**: ${reviewResult.filesReviewed.join(", ")}\n- **Issues Found**: ${reviewResult.issuesFound}\n- **Severity**: ${reviewResult.severity || "Not specified"}\n\n## Recommendations\n\n${reviewResult.recommendations.map((rec) => `- ${rec}`).join("\n")}\n\n---\n\n${reviewSummary}`;
					} catch (structuredError) {
						// If structured review fails, continue with the text-based review
						core.warning(
							`Could not generate structured review results: ${structuredError instanceof Error ? structuredError.message : String(structuredError)}`,
						);
					}

					// Review completed successfully
					core.info(
						`Review completed: reviewed ${reviewedFiles.size} files with ${commentsMade} comments`,
					);
					break;
				} catch (error) {
					// Handle errors with retries
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					core.warning(
						`Error during review (attempt ${retries + 1}/${maxRetries}): ${errorMessage}`,
					);

					// Check for specific error types
					if (
						errorMessage.includes("rate limit") ||
						errorMessage.includes("quota")
					) {
						core.warning(
							"Rate limit or quota exceeded. Waiting longer before retry...",
						);
						await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds
					}

					if (retries >= maxRetries - 1) {
						throw error;
					}

					// Exponential backoff
					const backoff = initialBackoff * 2 ** retries + Math.random() * 1000;
					core.warning(`Retrying in ${Math.round(backoff)}ms`);
					await new Promise((resolve) => setTimeout(resolve, backoff));
				}
			}

			// Provide a fallback summary if none was generated
			if (!reviewSummary) {
				reviewSummary = `Code review completed. Reviewed ${reviewedFiles.size} files with ${commentsMade} comments.`;
			}

			return reviewSummary;
		} catch (error) {
			core.error(
				`Error in Anthropic code review process: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw new Error(
				`Failed to complete code review with Anthropic: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
