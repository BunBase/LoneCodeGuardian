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

/**
 * Schema for detailed code review
 */
const CodeReviewSchema = z.object({
	summary: z.string().min(1, "Summary is required"),
	filesReviewed: z.array(
		z.object({
			filename: z.string(),
			issues: z
				.array(
					z.object({
						lineStart: z.number().int().positive(),
						lineEnd: z.number().int().positive(),
						description: z.string().min(1),
						severity: z.enum(["low", "medium", "high"]),
						suggestedFix: z.string().optional(),
					}),
				)
				.optional(),
			summary: z.string(),
		}),
	),
	overallSeverity: z.enum(["low", "medium", "high"]),
	recommendations: z.array(z.string()),
});

type ReviewResult = z.infer<typeof ReviewResultSchema>;
type CodeReview = z.infer<typeof CodeReviewSchema>;

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

		// Log the files being reviewed
		for (const file of changedFiles) {
			core.info(
				`File to review: ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`,
			);
		}

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

			// Log the tools being provided to the model
			core.info(
				`Providing ${Object.keys(tools).length} tools to the model: ${Object.keys(tools).join(", ")}`,
			);

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
					const prompt = `Here are the changed files in the pull request that need review (${changedFiles.length} files):

${simpleChangedFiles.map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`).join("\n")}

IMPORTANT INSTRUCTIONS:
1. You MUST use the get_file_content tool to examine EACH file before commenting on it
2. You MUST only review the files listed above - do not make up or reference non-existent files
3. You MUST base your review ONLY on the actual content of these files
4. You MUST use the exact filenames as listed above in your review
5. You MUST NOT mention files like "main.js", "auth.py", "database.sql", or any other files that are not in the list above

Please review these files for issues and provide specific actionable comments where appropriate. For each issue found, include the line numbers, description, severity, and a suggested fix if possible.`;

					core.info(
						`Sending prompt to Anthropic model with ${simpleChangedFiles.length} files`,
					);

					// Use generateObject to get structured review data
					core.info("Generating structured code review...");

					// First, use generateText to get tool calls
					const { text: _, toolCalls } = await generateText({
						model,
						system: this.getSystemPrompt(),
						prompt,
						tools,
						temperature: 0.2,
						maxTokens: 8000,
					});

					// Then, use generateObject to get structured review data
					const { object: detailedReview } = await generateObject({
						model,
						schema: CodeReviewSchema,
						prompt: `${prompt}\n\nPlease provide your review in a structured format.`,
						temperature: 0.2,
					});

					core.info(
						`Received structured review with ${toolCalls?.length || 0} tool calls`,
					);

					// Process tool calls
					if (toolCalls && toolCalls.length > 0) {
						core.info(`Processing ${toolCalls.length} tool calls`);
						for (const call of toolCalls) {
							core.info(
								`Tool call: ${call.toolName} with args: ${JSON.stringify(call.args)}`,
							);
							if (call.toolName === TOOL_NAMES.GET_FILE_CONTENT) {
								core.info(
									`Retrieved content for ${call.args.path_to_file} at lines ${call.args.start_line_number}-${call.args.end_line_number}`,
								);
							}
						}
					} else {
						core.warning(
							"No tool calls were made by the model. This suggests the model is not properly using the tools.",
						);
					}

					// Add review comments for each issue found
					for (const file of detailedReview.filesReviewed) {
						reviewedFiles.add(file.filename);

						if (file.issues && file.issues.length > 0) {
							for (const issue of file.issues) {
								try {
									await this.fileCommentator(
										`**${issue.severity.toUpperCase()} Severity Issue**: ${issue.description}${issue.suggestedFix ? `\n\n**Suggested Fix**:\n\`\`\`\n${issue.suggestedFix}\n\`\`\`` : ""}`,
										file.filename,
										"RIGHT",
										issue.lineStart,
										issue.lineEnd,
									);
									commentsMade++;
									core.info(
										`Added review comment to ${file.filename} at lines ${issue.lineStart}-${issue.lineEnd}`,
									);
								} catch (error) {
									core.warning(
										`Failed to add comment to ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							}
						}
					}

					// Generate the review summary
					reviewSummary = `# Code Review Summary\n\n${detailedReview.summary}\n\n## Details\n\n- **Files Reviewed**: ${detailedReview.filesReviewed.map((f) => f.filename).join(", ")}\n- **Issues Found**: ${detailedReview.filesReviewed.reduce((count, file) => count + (file.issues?.length || 0), 0)}\n- **Severity**: ${detailedReview.overallSeverity}\n\n## Recommendations\n\n${detailedReview.recommendations.map((rec) => `- ${rec}`).join("\n")}\n\n## File Summaries\n\n${detailedReview.filesReviewed.map((file) => `### ${file.filename}\n\n${file.summary}${file.issues && file.issues.length > 0 ? `\n\n**Issues**: ${file.issues.length}` : ""}`).join("\n\n")}`;

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
