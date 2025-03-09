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

/**
 * Schema for tool call request
 */
const ToolCallRequestSchema = z.object({
	action: z.enum([
		"get_file_content",
		"add_review_comment",
		"mark_as_done",
		"explore_project",
	]),
	params: z
		.object({
			// For get_file_content
			path_to_file: z.string().optional(),
			start_line_number: z.number().int().positive().optional(),
			end_line_number: z.number().int().positive().optional(),

			// For add_review_comment
			file_name: z.string().optional(),
			found_error_description: z.string().optional(),
			side: z.enum(["LEFT", "RIGHT"]).optional(),

			// For mark_as_done
			brief_summary: z.string().optional(),

			// For explore_project
			directory_path: z.string().optional(),
		})
		.partial(),
	reasoning: z.string().min(1, "Reasoning is required"),
});

/**
 * Schema for review step
 */
const ReviewStepSchema = z.object({
	currentFile: z.string(),
	analysisComplete: z.boolean().default(false),
	observations: z.array(z.string()).default([]),
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
	nextAction: ToolCallRequestSchema.optional(),
});

type ReviewResult = z.infer<typeof ReviewResultSchema>;
type CodeReview = z.infer<typeof CodeReviewSchema>;
type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
type ReviewStep = z.infer<typeof ReviewStepSchema>;

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

			// Store file contents and project structure
			const fetchedFileContents: Record<string, string> = {};
			let projectStructure = "";

			// Create a loop with retries for reliability
			for (let retries = 0; retries < maxRetries; retries++) {
				try {
					// Step 1: Get project structure to provide context
					core.info("Step 1: Fetching project structure...");

					try {
						// Use the fileContentGetter to get a list of files in the project
						// This is a simplified approach - in a real implementation, you might want to use a more sophisticated method
						const rootDir = "."; // Start from the root directory
						const projectFiles = await this.getProjectStructure(rootDir);
						projectStructure = projectFiles;
						core.info(
							`Successfully retrieved project structure (${projectStructure.length} characters)`,
						);
					} catch (error) {
						core.warning(
							`Failed to fetch project structure: ${error instanceof Error ? error.message : String(error)}`,
						);
						projectStructure = "Failed to retrieve project structure";
					}

					// Step 2: Process each file individually with a structured approach
					for (const file of simpleChangedFiles) {
						core.info(`Processing file: ${file.filename}`);
						reviewedFiles.add(file.filename);

						// Fetch the file content first
						try {
							const content = await this.fileContentGetter(file.filename);
							fetchedFileContents[file.filename] = content;
							core.info(
								`Retrieved content for ${file.filename} (${content.length} characters)`,
							);
						} catch (error) {
							core.warning(
								`Failed to fetch content for ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
							);
							continue; // Skip this file if we can't get its content
						}

						// Create initial context for the file review
						let initialContext = `
You are reviewing the file ${file.filename} which was ${file.status} in this pull request.
Changes: +${file.additions}/-${file.deletions} lines

Project Structure:
${projectStructure}

File Content:
\`\`\`
${fetchedFileContents[file.filename]}
\`\`\`

Please analyze this file for issues and provide your observations. For each issue, specify:
1. Line numbers (start and end)
2. Description of the issue
3. Severity (low, medium, high)
4. Category (security, performance, bug, type-safety, error-handling, maintainability, best-practice, other)
5. Suggested fix (if applicable)
6. Whether to suggest the fix as a GitHub diff (suggestDiff: true/false)

You can also request additional context by specifying a nextAction to explore the project or get content from other files.
`;

						// Use generateObject for structured file analysis
						let analysisComplete = false;
						let fileIssues: Array<{
							lineStart: number;
							lineEnd: number;
							description: string;
							severity: string;
							category: string;
							suggestedFix?: string;
							suggestDiff?: boolean;
						}> = [];
						let stepCount = 0;
						const maxSteps = 10; // Limit the number of steps to prevent infinite loops

						while (!analysisComplete && stepCount < maxSteps) {
							stepCount++;
							core.info(`File analysis step ${stepCount} for ${file.filename}`);

							try {
								const { object: reviewStep } = await generateObject({
									model,
									schema: ReviewStepSchema,
									prompt:
										initialContext +
										(stepCount > 1
											? "\n\nContinue your analysis based on the additional context."
											: ""),
									temperature: 0.1,
								});

								// Process the review step
								analysisComplete = reviewStep.analysisComplete;

								// Add any new issues to our collection
								if (reviewStep.issues && reviewStep.issues.length > 0) {
									fileIssues = [...fileIssues, ...reviewStep.issues];
									core.info(
										`Found ${reviewStep.issues.length} issues in ${file.filename}`,
									);

									// Add comments for each issue
									for (const issue of reviewStep.issues) {
										try {
											// Format the comment based on whether it's a suggested change
											let commentText: string;
											if (issue.suggestedFix && issue.suggestDiff) {
												commentText = this.formatSuggestedChange(
													issue.description,
													issue.severity,
													issue.category,
													issue.suggestedFix,
													file.filename,
													issue.lineStart,
													issue.lineEnd,
												);
											} else {
												commentText = `**${issue.severity.toUpperCase()} Severity ${issue.category.toUpperCase()} Issue**: ${issue.description}${issue.suggestedFix ? `\n\n**Suggested Fix**:\n\`\`\`\n${issue.suggestedFix}\n\`\`\`` : ""}`;
											}

											// Add the comment
											await this.fileCommentator(
												commentText,
												file.filename,
												"RIGHT",
												issue.lineStart,
												issue.lineEnd,
											);

											commentsMade++;
											core.info(
												`Added comment to ${file.filename} at lines ${issue.lineStart}-${issue.lineEnd}`,
											);
										} catch (error) {
											core.warning(
												`Failed to add comment to ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
											);
										}
									}
								}

								// Process next action if needed
								if (!analysisComplete && reviewStep.nextAction) {
									const action: ToolCallRequest = reviewStep.nextAction;
									core.info(`Executing next action: ${action.action}`);

									if (
										action.action === "get_file_content" &&
										action.params.path_to_file
									) {
										// Fetch content from another file for context
										try {
											const otherFilePath = action.params.path_to_file;
											const startLine = action.params.start_line_number || 1;
											const endLine = action.params.end_line_number || 1000; // Use a large number as default

											// Use the tool to get the content
											const content = await this.getFileContentWithCache(
												otherFilePath,
												startLine,
												endLine,
											);

											// Add this content to the context for the next iteration
											initialContext += `\n\nAdditional context from ${otherFilePath} (lines ${startLine}-${endLine}):\n${content}\n`;
											core.info(
												`Added content from ${otherFilePath} to context`,
											);
										} catch (error) {
											core.warning(
												`Failed to get content from ${action.params.path_to_file}: ${error instanceof Error ? error.message : String(error)}`,
											);
											initialContext += `\n\nFailed to get content from ${action.params.path_to_file}\n`;
										}
									} else if (
										action.action === "explore_project" &&
										action.params.directory_path
									) {
										// Explore a directory for context
										try {
											const dirPath = action.params.directory_path;
											const dirStructure =
												await this.getProjectStructure(dirPath);
											initialContext += `\n\nDirectory structure for ${dirPath}:\n${dirStructure}\n`;
											core.info(
												`Added directory structure for ${dirPath} to context`,
											);
										} catch (error) {
											core.warning(
												`Failed to explore directory ${action.params.directory_path}: ${error instanceof Error ? error.message : String(error)}`,
											);
											initialContext += `\n\nFailed to explore directory ${action.params.directory_path}\n`;
										}
									}
								}
							} catch (error) {
								core.warning(
									`Error in file analysis step: ${error instanceof Error ? error.message : String(error)}`,
								);
								analysisComplete = true; // Stop on error
							}
						}

						core.info(
							`Completed analysis of ${file.filename} with ${fileIssues.length} issues found`,
						);
					}

					// Step 3: Generate a structured summary of all findings
					core.info("Step 3: Generating structured summary...");

					// Create a summary prompt with all the information we've gathered
					const summaryPrompt = `
You have reviewed the following files in a pull request:
${simpleChangedFiles.map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`).join("\n")}

Project Structure:
${projectStructure}

Please provide a structured summary of your findings. Include a summary for each file, any issues found, and recommendations.
`;

					try {
						const { object: reviewResult } = await generateObject({
							model,
							schema: CodeReviewSchema,
							prompt: summaryPrompt,
							temperature: 0.1,
						});

						// Generate the review summary with categories
						reviewSummary = `# Code Review Summary\n\n${reviewResult.summary}\n\n## Details\n\n- **Files Reviewed**: ${reviewResult.filesReviewed.map((f) => f.filename).join(", ")}\n- **Issues Found**: ${reviewResult.filesReviewed.reduce((count, file) => count + file.issues.length, 0)}\n- **Severity**: ${reviewResult.overallSeverity}\n\n## Issues by Category\n\n${this.generateCategorySummary(reviewResult)}\n\n## Recommendations\n\n${reviewResult.recommendations.map((rec) => `- ${rec}`).join("\n")}\n\n## File Summaries\n\n${reviewResult.filesReviewed.map((file) => `### ${file.filename}\n\n${file.summary}${file.issues.length > 0 ? `\n\n**Issues**: ${file.issues.length}` : ""}`).join("\n\n")}`;
					} catch (error) {
						core.warning(
							`Failed to generate structured summary: ${error instanceof Error ? error.message : String(error)}`,
						);

						// Fallback to a simple summary
						reviewSummary = `# Code Review Summary\n\nReviewed ${reviewedFiles.size} files and found ${commentsMade} issues.`;
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

	/**
	 * Gets the project structure for a given directory
	 * @param dirPath - Path to the directory
	 * @returns A string representation of the directory structure
	 */
	async getProjectStructure(dirPath: string): Promise<string> {
		try {
			// We'll use the GitHub API to get the repository structure
			// This is more reliable than trying to use the file system directly
			// since the GitHub Action runs in various environments

			// First, check if we have access to the GitHub API through our fileContentGetter
			const owner = process.env.GITHUB_REPOSITORY_OWNER || "";
			const repo = process.env.GITHUB_REPOSITORY?.split("/")[1] || "";

			if (!owner || !repo) {
				// Fallback to a basic approach if we can't get the repository info
				return this.getBasicProjectStructure(dirPath);
			}

			// Use the GitHub API to get the repository contents
			try {
				// We'll use our fileContentGetter as a proxy to make a GitHub API request
				// This is a bit of a hack, but it allows us to reuse existing code
				const apiPath = `${dirPath}?type=dir`;
				const content = await this.fileContentGetter(apiPath);

				// Parse the content as JSON if possible
				try {
					const data = JSON.parse(content);
					return this.formatDirectoryStructure(data, dirPath);
				} catch (parseError) {
					// If we can't parse the content as JSON, use it as-is
					return `Directory: ${dirPath}\n${content}`;
				}
			} catch (apiError) {
				// Fallback to a basic approach if the API request fails
				return this.getBasicProjectStructure(dirPath);
			}
		} catch (error) {
			// Fallback to a basic approach if anything goes wrong
			return this.getBasicProjectStructure(dirPath);
		}
	}

	/**
	 * Formats directory data into a tree structure
	 * @param data - Directory data from GitHub API
	 * @param dirPath - Path to the directory
	 * @returns A string representation of the directory structure
	 */
	private formatDirectoryStructure(
		data: Array<{ name: string; type: string; path: string }>,
		dirPath: string,
	): string {
		if (!Array.isArray(data) || data.length === 0) {
			return `Directory: ${dirPath} (empty)`;
		}

		// Sort entries: directories first, then files
		const sortedData = [...data].sort((a, b) => {
			if (a.type === "dir" && b.type !== "dir") return -1;
			if (a.type !== "dir" && b.type === "dir") return 1;
			return a.name.localeCompare(b.name);
		});

		// Format the directory structure
		let result = `Directory: ${dirPath}\n`;

		for (let i = 0; i < sortedData.length; i++) {
			const entry = sortedData[i];
			const isLast = i === sortedData.length - 1;
			const prefix = isLast ? "└── " : "├── ";

			if (entry.type === "dir") {
				result += `${prefix}${entry.name}/\n`;
			} else {
				result += `${prefix}${entry.name}\n`;
			}
		}

		return result;
	}

	/**
	 * Gets a basic project structure when GitHub API is not available
	 * @param dirPath - Path to the directory
	 * @returns A basic string representation of the directory structure
	 */
	private getBasicProjectStructure(dirPath: string): string {
		// Instead of hardcoding the structure, we'll try to infer it from common patterns
		// and environment variables available in GitHub Actions

		// Get repository information from environment variables
		const repoName = process.env.GITHUB_REPOSITORY || "unknown/repository";
		const workflowName = process.env.GITHUB_WORKFLOW || "code-review";
		const runnerOS = process.env.RUNNER_OS || "Linux";
		const actionPath = process.env.GITHUB_ACTION_PATH || "";

		// Create a generic message that doesn't assume specific file structure
		return `
Directory: ${dirPath} (dynamically inferred)
Note: Actual structure not available. The code review will focus on the changed files without assuming a specific project structure.

Repository: ${repoName}
Workflow: ${workflowName}
Runner OS: ${runnerOS}
Action Path: ${actionPath}

Common directories that might exist:
- src/ or lib/ (Source code)
- test/ or tests/ (Test files)
- docs/ (Documentation)
- config/ or conf/ (Configuration)
- dist/ or build/ (Build artifacts)
- node_modules/ (Node.js dependencies, if applicable)
- .github/ (GitHub-specific files)

The code review will analyze the changed files in context, focusing on:
- Code quality and correctness
- Security vulnerabilities
- Performance issues
- Type safety (for typed languages)
- Error handling
- Best practices
`;
	}
}
