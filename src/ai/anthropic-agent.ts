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
						category: z
							.enum([
								"security",
								"performance",
								"bug",
								"type-safety",
								"error-handling",
								"maintainability",
								"best-practice",
								"other",
							])
							.default("other"),
						suggestedFix: z.string().optional(),
						suggestDiff: z.boolean().default(false),
					}),
				)
				.default([]),
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

					// Step 1: First, use generateText to fetch file content
					core.info("Step 1: Fetching file content...");

					// Create a more explicit prompt for fetching file content
					const fetchPrompt = `I need to review the following files in a pull request:

${simpleChangedFiles.map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`).join("\n")}

IMPORTANT: You MUST use the get_file_content tool to fetch the ENTIRE content of EACH file listed above.
For each file:
1. Call get_file_content with the file path
2. Use a large enough range to get the full file (e.g., lines 1-1000)
3. Confirm you have fetched the content before proceeding

Please fetch the content of all files now.`;

					// Fetch file content with a more explicit prompt
					const { toolCalls: fetchToolCalls } = await generateText({
						model,
						system: this.getSystemPrompt(),
						prompt: fetchPrompt,
						tools,
						temperature: 0.2,
						maxTokens: 4000,
					});

					// Process fetch tool calls and store file contents for later use
					const fetchedFileContents: Record<string, string> = {};
					if (fetchToolCalls && fetchToolCalls.length > 0) {
						core.info(`Processing ${fetchToolCalls.length} fetch tool calls`);
						for (const call of fetchToolCalls) {
							core.info(
								`Tool call: ${call.toolName} with args: ${JSON.stringify(call.args)}`,
							);
							if (call.toolName === TOOL_NAMES.GET_FILE_CONTENT) {
								const filePath = call.args.path_to_file;
								// Store the fetched content for later use
								try {
									const content = await this.fileContentGetter(filePath);
									fetchedFileContents[filePath] = content;
									core.info(
										`Retrieved and stored content for ${filePath} (${content.length} characters)`,
									);
								} catch (error) {
									core.warning(
										`Failed to fetch content for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							}
						}
					} else {
						core.warning(
							"No fetch tool calls were made. This may affect the quality of the review.",
						);

						// Fallback: Manually fetch content for all files
						core.info("Manually fetching file content as fallback...");
						for (const file of simpleChangedFiles) {
							try {
								const content = await this.fileContentGetter(file.filename);
								fetchedFileContents[file.filename] = content;
								core.info(
									`Manually retrieved content for ${file.filename} (${content.length} characters)`,
								);
							} catch (error) {
								core.warning(
									`Failed to manually fetch content for ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
					}

					// Step 2: Now, use generateText to analyze the files and identify issues
					core.info("Step 2: Analyzing files and identifying issues...");

					// Create a more explicit prompt that includes the file content
					let reviewPrompt = `I need you to review the following files in a pull request:

${simpleChangedFiles.map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`).join("\n")}

Here is the content of each file:

`;

					// Add the content of each file to the prompt
					for (const [filePath, content] of Object.entries(
						fetchedFileContents,
					)) {
						// Add a section for each file with its content
						reviewPrompt += `\n\n=== FILE: ${filePath} ===\n\n\`\`\`typescript\n${content}\n\`\`\`\n`;
					}

					// Add instructions for the review
					reviewPrompt += `\n\nPlease review these files for issues. For each issue you find, use the add_review_comment tool to add a comment to the specific lines of code.

Focus on:
- Real bugs and logic errors (high priority)
- Security vulnerabilities (high priority)
- Type safety issues
- Error handling problems
- Performance concerns

For each issue, provide:
1. The file name
2. The line numbers where the issue occurs
3. A description of the issue
4. The severity (low, medium, high)
5. A suggested fix if possible

When you're done reviewing, use the mark_as_done tool with a brief summary.`;

					// Check if the prompt is too long and truncate if necessary
					const maxPromptLength = 100000; // Set a reasonable limit
					if (reviewPrompt.length > maxPromptLength) {
						core.warning(
							`Review prompt is too long (${reviewPrompt.length} chars). Truncating to ${maxPromptLength} chars.`,
						);
						reviewPrompt = reviewPrompt.substring(0, maxPromptLength);
					}

					// Analyze the files with the content included in the prompt
					const { toolCalls: reviewToolCalls } = await generateText({
						model,
						system: this.getSystemPrompt(),
						prompt: reviewPrompt,
						tools,
						temperature: 0.2,
						maxTokens: 8000,
					});

					// Process review tool calls
					let reviewSummaryFromMarkAsDone = "";
					if (reviewToolCalls && reviewToolCalls.length > 0) {
						core.info(`Processing ${reviewToolCalls.length} review tool calls`);
						for (const call of reviewToolCalls) {
							core.info(
								`Tool call: ${call.toolName} with args: ${JSON.stringify(call.args)}`,
							);
							if (call.toolName === TOOL_NAMES.ADD_REVIEW_COMMENT) {
								commentsMade++;
								reviewedFiles.add(call.args.file_name);
								core.info(
									`Added review comment to ${call.args.file_name} at lines ${call.args.start_line_number}-${call.args.end_line_number}`,
								);

								// Actually add the comment
								try {
									await this.fileCommentator(
										call.args.found_error_description,
										call.args.file_name,
										call.args.side || "RIGHT",
										call.args.start_line_number,
										call.args.end_line_number,
									);
								} catch (error) {
									core.warning(
										`Failed to add comment to ${call.args.file_name}: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							} else if (call.toolName === TOOL_NAMES.MARK_AS_DONE) {
								reviewSummaryFromMarkAsDone = call.args.brief_summary;
								core.info(
									`Marked review as done with summary: ${reviewSummaryFromMarkAsDone.substring(0, 100)}...`,
								);
							}
						}
					} else {
						core.warning(
							"No review tool calls were made. This suggests the model didn't find any issues or didn't properly use the tools.",
						);
					}

					// Step 3: Generate a structured summary
					core.info("Step 3: Generating structured summary...");

					// Create a summary prompt that includes file content summaries
					let summaryPrompt = `Based on your review of the following files:

${simpleChangedFiles.map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`).join("\n")}

Here are brief summaries of each file's content:

`;

					// Add a summary of each file's content
					for (const [filePath, content] of Object.entries(
						fetchedFileContents,
					)) {
						// Add a brief description of each file (first 500 chars)
						const contentPreview =
							content.length > 500
								? `${content.substring(0, 500)}...`
								: content;
						summaryPrompt += `\n\n=== FILE: ${filePath} ===\nPreview: ${contentPreview}\n`;
					}

					// Add instructions for the structured summary
					summaryPrompt += `\n\nPlease provide a structured summary of your findings. Include a summary for each file, any issues found, and recommendations.

For each issue, please categorize it as one of the following:
- security: Security vulnerabilities or concerns
- performance: Performance issues or inefficiencies
- bug: Logical errors or bugs in the code
- type-safety: Type safety issues or potential runtime errors
- error-handling: Inadequate or improper error handling
- maintainability: Code that is difficult to maintain or understand
- best-practice: Violations of best practices
- other: Any other issues that don't fit the above categories

Also, for each issue with a suggested fix, indicate whether the fix should be presented as a GitHub suggested change (suggestDiff: true).`;

					try {
						const { object: reviewResult } = await generateObject({
							model,
							schema: CodeReviewSchema,
							prompt: summaryPrompt,
							temperature: 0.1,
						});

						// Process the structured review to add GitHub suggested changes
						for (const file of reviewResult.filesReviewed) {
							for (const issue of file.issues) {
								if (issue.suggestedFix && issue.suggestDiff) {
									try {
										// Format the comment to include GitHub's suggested changes syntax
										const suggestedChangeComment = this.formatSuggestedChange(
											issue.description,
											issue.severity,
											issue.category,
											issue.suggestedFix,
											file.filename,
											issue.lineStart,
											issue.lineEnd,
										);

										// Add the suggested change comment
										await this.fileCommentator(
											suggestedChangeComment,
											file.filename,
											"RIGHT",
											issue.lineStart,
											issue.lineEnd,
										);

										commentsMade++;
										core.info(
											`Added suggested change to ${file.filename} at lines ${issue.lineStart}-${issue.lineEnd}`,
										);
									} catch (error) {
										core.warning(
											`Failed to add suggested change to ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
										);
									}
								}
							}
						}

						// Generate the review summary with categories
						reviewSummary = `# Code Review Summary\n\n${reviewResult.summary}\n\n## Details\n\n- **Files Reviewed**: ${reviewResult.filesReviewed.map((f) => f.filename).join(", ")}\n- **Issues Found**: ${reviewResult.filesReviewed.reduce((count, file) => count + file.issues.length, 0)}\n- **Severity**: ${reviewResult.overallSeverity}\n\n## Issues by Category\n\n${this.generateCategorySummary(reviewResult)}\n\n## Recommendations\n\n${reviewResult.recommendations.map((rec) => `- ${rec}`).join("\n")}\n\n## File Summaries\n\n${reviewResult.filesReviewed.map((file) => `### ${file.filename}\n\n${file.summary}${file.issues.length > 0 ? `\n\n**Issues**: ${file.issues.length}` : ""}`).join("\n\n")}`;
					} catch (error) {
						core.warning(
							`Failed to generate structured summary: ${error instanceof Error ? error.message : String(error)}`,
						);

						// Fallback to using the mark_as_done summary
						if (reviewSummaryFromMarkAsDone) {
							reviewSummary = `# Code Review Summary\n\n${reviewSummaryFromMarkAsDone}`;
						} else {
							reviewSummary = `# Code Review Summary\n\nReviewed ${reviewedFiles.size} files and found ${commentsMade} issues.`;
						}
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

	/**
	 * Formats a suggested change comment with GitHub's suggested changes syntax
	 */
	formatSuggestedChange(
		description: string,
		severity: string,
		category: string,
		suggestedFix: string,
		filename: string,
		lineStart: number,
		lineEnd: number,
	): string {
		return `**${severity.toUpperCase()} Severity ${category.toUpperCase()} Issue**: ${description}

\`\`\`suggestion
${suggestedFix}
\`\`\``;
	}

	/**
	 * Generates a summary of issues grouped by category
	 */
	generateCategorySummary(reviewResult: CodeReview): string {
		const categoryCounts: Record<string, number> = {};
		const categoryIssues: Record<
			string,
			Array<{ file: string; description: string; severity: string }>
		> = {};

		// Count issues by category
		for (const file of reviewResult.filesReviewed) {
			for (const issue of file.issues) {
				const category = issue.category;
				categoryCounts[category] = (categoryCounts[category] || 0) + 1;

				if (!categoryIssues[category]) {
					categoryIssues[category] = [];
				}

				categoryIssues[category].push({
					file: file.filename,
					description: issue.description,
					severity: issue.severity,
				});
			}
		}

		// Generate summary text
		let summary = "";
		for (const category of Object.keys(categoryCounts).sort()) {
			const count = categoryCounts[category];
			summary += `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${count})\n\n`;

			for (const issue of categoryIssues[category]) {
				summary += `- **[${issue.severity.toUpperCase()}]** ${issue.file}: ${issue.description}\n`;
			}

			summary += "\n";
		}

		return summary;
	}
}
