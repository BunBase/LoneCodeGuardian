import * as fs from "node:fs";
import * as path from "node:path";
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

			// Add protection against infinite loops
			let totalSteps = 0;
			const MAX_TOTAL_STEPS = 50; // Absolute maximum number of steps across all files

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

						// Skip if we've reached the maximum total steps (global safety limit)
						if (totalSteps >= MAX_TOTAL_STEPS) {
							core.warning(
								`Reached maximum total steps (${MAX_TOTAL_STEPS}). This is a safety limit to prevent infinite loops. Stopping review.`,
							);
							break;
						}

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
							totalSteps++; // Increment global step counter for safety limit

							core.info(
								`File analysis step ${stepCount} for ${file.filename} (total steps: ${totalSteps}/${MAX_TOTAL_STEPS})`,
							);

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
											// Get the total number of lines for proper validation
											const fileLines =
												fetchedFileContents[file.filename].split("\n");
											const totalLines = fileLines.length;

											// Validate line numbers are within file bounds
											if (
												issue.lineStart < 1 ||
												issue.lineEnd > totalLines ||
												issue.lineStart > issue.lineEnd
											) {
												core.warning(
													`Skipping comment with invalid line numbers (${issue.lineStart}-${issue.lineEnd}) for ${file.filename}. File has ${totalLines} lines.`,
												);
												continue;
											}

											// Extract the actual line content for validation
											const targetLineContent =
												fileLines[issue.lineStart - 1]?.trim() || "";
											const contextLines = fileLines
												.slice(
													Math.max(0, issue.lineStart - 3),
													Math.min(totalLines, issue.lineEnd + 3),
												)
												.join("\n");

											// Verify comment relevance to avoid misplaced comments
											if (
												!this.isCommentRelevantToLineContent(
													issue.description,
													targetLineContent,
													contextLines,
												)
											) {
												// Try to find a better matching line nearby
												const betterLine = this.findBetterMatchingLine(
													issue.description,
													fileLines,
													issue.lineStart,
													10, // Look 10 lines before and after
												);

												if (betterLine !== issue.lineStart) {
													core.info(
														`Relocating comment from line ${issue.lineStart} to better matching line ${betterLine}`,
													);
													issue.lineStart = betterLine;
													issue.lineEnd = betterLine;
												} else {
													core.warning(
														`Comment doesn't seem relevant to line ${issue.lineStart}. Skipping to avoid misplacement.`,
													);
													continue;
												}
											}

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
											const content = await this.getFileContent(
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
			// Since we're in a GitHub Action with a full checkout,
			// we can directly use Node's fs module to list directories

			// Normalize the directory path
			const normalizedPath = path.normalize(
				dirPath === "." ? process.cwd() : dirPath,
			);

			core.info(`Getting project structure for: ${normalizedPath}`);

			// Check if the directory exists
			if (
				!fs.existsSync(normalizedPath) ||
				!fs.statSync(normalizedPath).isDirectory()
			) {
				return `Directory not found: ${normalizedPath}`;
			}

			// Generate the directory tree recursively (with reasonable depth limits)
			const tree = await this.generateDirectoryTree(normalizedPath, 3); // Max depth of 3
			return tree;
		} catch (error) {
			core.warning(
				`Error getting project structure: ${error instanceof Error ? error.message : String(error)}`,
			);
			return this.getBasicProjectStructure(dirPath);
		}
	}

	/**
	 * Recursively generates a directory tree
	 * @param dir - Directory to traverse
	 * @param maxDepth - Maximum depth to traverse
	 * @param currentDepth - Current traversal depth
	 * @returns Formatted tree structure
	 */
	private async generateDirectoryTree(
		dir: string,
		maxDepth: number,
		currentDepth = 0,
	): Promise<string> {
		// Stop recursion if we've reached max depth
		if (currentDepth > maxDepth) {
			return `${path.basename(dir)}/ (max depth reached)`;
		}

		try {
			// Read the directory contents
			const items = fs.readdirSync(dir);

			// Filter and sort items (directories first, then files)
			const sortedItems = items
				.filter(
					(item: string) =>
						!item.startsWith(".git") &&
						item !== "node_modules" &&
						item !== "dist",
				)
				.sort((a: string, b: string) => {
					const aIsDir = fs.statSync(path.join(dir, a)).isDirectory();
					const bIsDir = fs.statSync(path.join(dir, b)).isDirectory();
					if (aIsDir && !bIsDir) return -1;
					if (!aIsDir && bIsDir) return 1;
					return a.localeCompare(b);
				});

			// Build the tree
			let result = currentDepth === 0 ? `Directory: ${dir}\n` : "";

			// Add each item to the tree
			for (let i = 0; i < sortedItems.length; i++) {
				const item = sortedItems[i];
				const itemPath = path.join(dir, item);
				const isDir = fs.statSync(itemPath).isDirectory();
				const isLast = i === sortedItems.length - 1;

				// Calculate the current indent and prefix
				const indent = currentDepth === 0 ? "" : "  ".repeat(currentDepth);
				const prefix = isLast ? "└── " : "├── ";

				// Add the item to the tree
				result += `${indent}${prefix}${item}${isDir ? "/" : ""}\n`;

				// Recursively process subdirectories
				if (isDir) {
					const childIndent =
						currentDepth === 0 ? "" : "  ".repeat(currentDepth);
					const childPrefix = isLast ? "    " : "│   ";
					const childTree = await this.generateDirectoryTree(
						itemPath,
						maxDepth,
						currentDepth + 1,
					);

					// Add the child tree, maintaining the proper indentation
					const childLines = childTree
						.split("\n")
						.filter((line) => line.trim());
					for (const line of childLines) {
						result += `${childIndent}${childPrefix}${line}\n`;
					}
				}
			}

			return result;
		} catch (error) {
			return `Error reading directory: ${error instanceof Error ? error.message : String(error)}`;
		}
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

	/**
	 * Check if a comment is relevant to specific line content
	 * @param comment - The comment text to check
	 * @param lineContent - The content of the line where the comment would be placed
	 * @param contextLines - Surrounding lines for additional context
	 * @returns True if the comment seems relevant to the line
	 */
	private isCommentRelevantToLineContent(
		comment: string,
		lineContent: string,
		contextLines: string,
	): boolean {
		// If the line is very short, rely more on context
		if (lineContent.length < 10) {
			// Check if any keywords from the comment appear in the context
			return this.hasCommonKeywords(comment, contextLines);
		}

		// For longer lines, check direct relevance first
		if (this.hasCommonKeywords(comment, lineContent)) {
			return true;
		}

		// Fall back to context check
		return this.hasCommonKeywords(comment, contextLines);
	}

	/**
	 * Find a better matching line for a comment if the original line doesn't match well
	 * @param comment - The comment text to find a match for
	 * @param fileLines - All lines in the file
	 * @param originalLine - The original line number suggested
	 * @param searchRadius - How many lines to search around the original line
	 * @returns The best matching line number or the original if no better match found
	 */
	private findBetterMatchingLine(
		comment: string,
		fileLines: string[],
		originalLine: number,
		searchRadius = 5,
	): number {
		// Prevent invalid line numbers
		if (originalLine < 1 || originalLine > fileLines.length) {
			return Math.min(Math.max(1, originalLine), fileLines.length);
		}

		// Define the search range
		const startLine = Math.max(0, originalLine - searchRadius - 1);
		const endLine = Math.min(fileLines.length, originalLine + searchRadius - 1);

		// Track best matching line and score
		let bestMatchLine = originalLine;
		let bestMatchScore = this.calculateRelevanceScore(
			comment,
			fileLines[originalLine - 1],
		);

		// Search for better matches in the range
		for (let i = startLine; i <= endLine; i++) {
			// Skip the original line as we already scored it
			if (i === originalLine - 1) continue;

			const lineContent = fileLines[i];
			const score = this.calculateRelevanceScore(comment, lineContent);

			// If this is a better match, update our best match
			if (score > bestMatchScore) {
				bestMatchScore = score;
				bestMatchLine = i + 1; // +1 because array is 0-indexed but lines are 1-indexed
			}
		}

		return bestMatchLine;
	}

	/**
	 * Calculate a numerical score for how relevant a comment is to a line of code
	 * @param comment - The comment text
	 * @param lineContent - The line content to match against
	 * @returns A relevance score (higher is better)
	 */
	private calculateRelevanceScore(
		comment: string,
		lineContent: string,
	): number {
		// Start with no relevance
		let score = 0;

		// Extract keywords from both texts
		const commentKeywords = this.extractKeywords(comment);
		const lineKeywords = this.extractKeywords(lineContent);

		// Count matching keywords
		const matches = commentKeywords.filter((keyword) =>
			lineKeywords.includes(keyword),
		);
		score += matches.length * 2;

		// Bonus points for exact phrases
		const commentLower = comment.toLowerCase();
		const lineLower = lineContent.toLowerCase();

		// Check if this is a declaration or function that matches mention in comment
		if (
			(lineLower.includes("function") ||
				lineLower.includes("const ") ||
				lineLower.includes("let ") ||
				lineLower.includes("var ") ||
				lineLower.includes("class ")) &&
			this.extractIdentifiers(lineContent).some((id) =>
				commentLower.includes(id.toLowerCase()),
			)
		) {
			score += 5;
		}

		// Penalize very short lines (likely just brackets or punctuation)
		if (lineContent.trim().length < 3) {
			score -= 2;
		}

		return score;
	}

	/**
	 * Extract relevant keywords from text
	 * @param text - Text to extract keywords from
	 * @returns Array of keywords
	 */
	private extractKeywords(text: string): string[] {
		// Convert to lowercase and split into words
		const words = text.toLowerCase().split(/[^a-z0-9_]+/);

		// Filter out common words and very short words
		return words.filter(
			(word) =>
				word.length > 2 &&
				!["the", "and", "for", "that", "this", "with", "have", "from"].includes(
					word,
				),
		);
	}

	/**
	 * Extract potential code identifiers from a line of code
	 * @param lineContent - Code line to analyze
	 * @returns Array of potential identifiers
	 */
	private extractIdentifiers(lineContent: string): string[] {
		// Very basic extraction - in a real implementation this could use more sophisticated parsing
		const identifierRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
		const matches = lineContent.match(identifierRegex) || [];

		// Filter out common keywords
		const keywords = [
			"if",
			"for",
			"while",
			"function",
			"const",
			"let",
			"var",
			"return",
			"break",
			"continue",
		];
		return matches.filter((match) => !keywords.includes(match));
	}

	/**
	 * Check if two texts share meaningful keywords
	 * @param text1 - First text to compare
	 * @param text2 - Second text to compare
	 * @returns True if the texts share any meaningful keywords
	 */
	private hasCommonKeywords(text1: string, text2: string): boolean {
		// Extract keywords from both texts
		const text1Keywords = this.extractKeywords(text1);
		const text2Keywords = this.extractKeywords(text2);

		// Check for any common keywords
		return text1Keywords.some((keyword) => text2Keywords.includes(keyword));
	}
}
