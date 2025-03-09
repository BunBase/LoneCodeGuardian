import { z } from "zod";
import {
	type AddReviewCommentArgs,
	type ChangedFile,
	type FileCommentator,
	type FileContentGetter,
	type GetFileContentArgs,
	type MarkAsDoneArgs,
	REVIEW_SIDES,
	type ReviewSide,
	TOOL_NAMES,
} from "../types/constants";

/**
 * Base AIAgent class that provides common functionality for all AI providers
 */
export abstract class AIAgent {
	protected fileCache: Map<string, string> = new Map();
	protected cacheLock = false;

	/**
	 * Creates a new AIAgent instance
	 * @param apiKey - API key for the AI provider
	 * @param fileContentGetter - Function to get file content
	 * @param fileCommentator - Function to add review comments
	 * @param model - AI model to use
	 */
	constructor(
		protected apiKey: string,
		protected fileContentGetter: FileContentGetter,
		protected fileCommentator: FileCommentator,
		protected model: string,
	) {}

	/**
	 * Get the system prompt for the AI model
	 */
	protected getSystemPrompt(): string {
		return `You are an expert code reviewer analyzing a GitHub pull request as part of an automated CI pipeline. You must work independently without human interaction. Review for logical errors, bugs, and security issues.

Focus on:
- Real bugs and logic errors (high priority)
- Security vulnerabilities (high priority)
- Typos

Skip and do not comment on (but you can mention these in the summary):
- Formatting and code style preferences (the lowest priority)
- Performance issues
- Code maintainability issues
- Best practices

For each issue found, use the get_file_content tool to retrieve additional context if needed, and the add_review_comment tool to add specific, actionable comments to the code.

The "changedFiles" object contains information about files that were modified in the PR, including:
- filename: The path to the changed file
- status: The change status (added, modified, etc.)
- patch: The diff showing what was changed
- additions: The number of added lines
- deletions: The number of deleted lines

You MUST use the get_file_content tool to examine files for a thorough review. Always examine the content you receive and make determinations based on that content.

When complete, call the mark_as_done tool with a brief summary of the review. The summary should ONLY include:
- A concise overview of what was changed in the code
- The overall quality assessment of the changes
- Any patterns or recurring issues observed
- DO NOT ask questions or request more information in the summary
- DO NOT mention "I couldn't see the changes" - use the tools to retrieve any content you need

Lines are 1-indexed. Do not comment on trivial issues or style preferences.
Be concise but thorough in your review.
=> MODE NO-FALSE-POSITIVES IS ON.`;
	}

	/**
	 * Get file content with caching
	 * @param pathToFile - Path to the file
	 * @param startLineNumber - Start line number
	 * @param endLineNumber - End line number
	 * @returns File content
	 */
	protected async getFileContentWithCache(
		pathToFile: string,
		startLineNumber: number,
		endLineNumber: number,
	): Promise<string> {
		try {
			const acquireLock = async (): Promise<void> => {
				const timeout = 5000; // 5 seconds
				const start = Date.now();
				while (this.cacheLock) {
					if (Date.now() - start > timeout) {
						throw new Error("Timeout while waiting for cache lock");
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				this.cacheLock = true;
			};

			const releaseLock = (): void => {
				this.cacheLock = false;
			};

			await acquireLock();
			let content: string;

			try {
				if (!this.fileCache.has(pathToFile)) {
					releaseLock();
					content = await this.fileContentGetter(pathToFile);
					await acquireLock();
					this.fileCache.set(pathToFile, content);
				} else {
					content = this.fileCache.get(pathToFile) || "";
				}
			} finally {
				releaseLock();
			}

			const span = 20; // Context lines before and after
			const lines = content.split("\n");
			const startIndex = Math.max(0, startLineNumber - 1 - span);
			const endIndex = Math.min(lines.length, endLineNumber + span);
			const selectedLines = lines.slice(startIndex, endIndex);
			return `\`\`\`${pathToFile}\n${selectedLines.join("\n")}\n\`\`\``;
		} catch (error) {
			if (this.cacheLock) {
				this.cacheLock = false;
			}
			throw new Error(
				`Error getting file content: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Validate line numbers
	 * @param startLineNumber - Start line number
	 * @param endLineNumber - End line number
	 * @returns Error message or null if valid
	 */
	protected validateLineNumbers(
		startLineNumber: number,
		endLineNumber: number,
	): string | null {
		if (!Number.isInteger(startLineNumber) || startLineNumber < 1) {
			return "Error: Start line number must be a positive integer";
		}
		if (!Number.isInteger(endLineNumber) || endLineNumber < 1) {
			return "Error: End line number must be a positive integer";
		}
		if (startLineNumber > endLineNumber) {
			return "Error: Start line number cannot be greater than end line number";
		}
		return null;
	}

	/**
	 * Add a review comment
	 * @param fileName - File name
	 * @param startLineNumber - Start line number
	 * @param endLineNumber - End line number
	 * @param foundErrorDescription - Error description
	 * @param side - Side of the diff (LEFT or RIGHT)
	 * @returns Success or error message
	 */
	protected async addReviewComment(
		fileName: string,
		startLineNumber: number,
		endLineNumber: number,
		foundErrorDescription: string,
		side: ReviewSide = REVIEW_SIDES.RIGHT,
	): Promise<string> {
		try {
			const validationError = this.validateLineNumbers(
				startLineNumber,
				endLineNumber,
			);
			if (validationError) {
				throw new Error(validationError);
			}

			await this.fileCommentator(
				foundErrorDescription,
				fileName,
				side,
				startLineNumber,
				endLineNumber,
			);
			return "Success! The review comment has been published.";
		} catch (error) {
			return `Error! Please ensure that the lines you specify for the comment are part of the DIFF! Error message: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/**
	 * Get tools definition for Vercel AI SDK
	 * @returns Tools object with tool definitions
	 */
	protected getTools() {
		return {
			[TOOL_NAMES.GET_FILE_CONTENT]: {
				description: "Retrieves file content for context",
				parameters: z.object({
					path_to_file: z
						.string()
						.describe("The fully qualified path to the file"),
					start_line_number: z
						.number()
						.int()
						.min(1)
						.describe(
							"The starting line from the file content to retrieve, counting from one",
						),
					end_line_number: z
						.number()
						.int()
						.min(1)
						.describe(
							"The ending line from the file content to retrieve, counting from one",
						),
				}),
				execute: async (args: any) => {
					const typedArgs = args as GetFileContentArgs;
					return await this.getFileContentWithCache(
						typedArgs.path_to_file,
						typedArgs.start_line_number,
						typedArgs.end_line_number,
					);
				},
			},

			[TOOL_NAMES.ADD_REVIEW_COMMENT]: {
				description:
					"Adds a review comment to a specific range of lines in the pull request diff",
				parameters: z.object({
					file_name: z
						.string()
						.describe(
							"The relative path to the file that necessitates a comment",
						),
					start_line_number: z
						.number()
						.int()
						.min(1)
						.describe(
							"The starting line number where the comment should begin from the diff hunk (start_line_number must be strictly greater than first diff hunk line number)",
						),
					end_line_number: z
						.number()
						.int()
						.min(1)
						.describe(
							"The ending line number where the comment should end from the diff hunk (end_line_number must be strictly greater than start_line_number and strictly less than last diff hunk line number)",
						),
					found_error_description: z
						.string()
						.describe("The review comment content"),
					side: z
						.enum([REVIEW_SIDES.LEFT, REVIEW_SIDES.RIGHT])
						.default(REVIEW_SIDES.RIGHT)
						.describe(
							"In a split diff view, the side of the diff that the pull request's changes appear on. Can be LEFT or RIGHT. Use LEFT only for deletions. Use RIGHT for additions/changes! For a multi-line comment, side represents whether the last line of the comment range is a deletion or addition.",
						),
				}),
				execute: async (args: any) => {
					const typedArgs = args as AddReviewCommentArgs;
					return await this.addReviewComment(
						typedArgs.file_name,
						typedArgs.start_line_number,
						typedArgs.end_line_number,
						typedArgs.found_error_description,
						typedArgs.side || REVIEW_SIDES.RIGHT,
					);
				},
			},

			[TOOL_NAMES.MARK_AS_DONE]: {
				description:
					"Marks the code review as completed and provides a brief summary of the changes",
				parameters: z.object({
					brief_summary: z
						.string()
						.describe(
							"A brief summary of the changes reviewed. Do not repeat comments. Focus on overall quality and any patterns observed.",
						),
				}),
				execute: async (args: any) => {
					const typedArgs = args as MarkAsDoneArgs;
					return typedArgs.brief_summary;
				},
			},
		};
	}

	/**
	 * Do a code review on the changed files
	 * This method must be implemented by each provider
	 * @param changedFiles - List of changed files
	 * @returns Review summary
	 */
	abstract doReview(changedFiles: ChangedFile[]): Promise<string>;
}
