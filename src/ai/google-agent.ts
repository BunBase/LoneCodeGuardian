import * as core from "@actions/core";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { generateText } from "ai";
import { type ChangedFile, TOOL_NAMES } from "../types/constants";
import { AIAgent } from "./ai-agent";

/**
 * AI agent implementation for Google Gemini
 */
export class GoogleAgent extends AIAgent {
	/**
	 * Perform a code review on the provided changed files using Google Gemini
	 * @param changedFiles - List of changed files
	 * @returns Review summary
	 */
	async doReview(changedFiles: ChangedFile[]): Promise<string> {
		core.info(`Starting code review with Google Gemini model: ${this.model}`);
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

			// Set up tools for Google
			const tools = this.getTools();

			// Create the Google model with the API key
			const googleProvider = createGoogleGenerativeAI({
				apiKey: this.apiKey,
			});

			const model = googleProvider(this.model);

			// Initialize variables to capture the review result
			let reviewSummary = "";
			const reviewedFiles = new Set<string>();
			let commentsMade = 0;

			// Create a loop with retries for reliability
			for (let retries = 0; retries < maxRetries; retries++) {
				try {
					// Run the code review
					core.info(
						`Attempt ${retries + 1}/${maxRetries} to generate review using Google model`,
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
				`Error in Google code review process: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw new Error(
				`Failed to complete code review with Google: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
