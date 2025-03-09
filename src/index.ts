import * as core from "@actions/core";
import { InputProcessor } from "./config/input-processor";
import { AI_REVIEW_COMMENT_PREFIX, SUMMARY_SEPARATOR } from "./types/constants";

/**
 * Main function to run the GitHub Action
 */
const main = async (): Promise<void> => {
	core.info("Starting AI Code Review GitHub Action");
	const startTime = Date.now();

	try {
		// Create and process inputs
		core.info("Processing inputs and preparing for review...");
		const inputProcessor = await InputProcessor.create();
		await inputProcessor.processInputs();

		// Check if there are files to review
		if (inputProcessor.getFilteredDiffs.length === 0) {
			core.info("No files to review. Exiting.");
			return;
		}

		// Get the appropriate AI agent and run the review
		core.info("Starting code review...");
		const aiAgent = inputProcessor.getAIAgent();
		const reviewSummary = await aiAgent.doReview(
			inputProcessor.getFilteredDiffs,
		);

		// Validate review summary
		if (
			!reviewSummary ||
			typeof reviewSummary !== "string" ||
			reviewSummary.trim() === ""
		) {
			throw new Error("AI Agent did not return a valid review summary");
		}

		// Create a comment with the review summary
		const githubAPI = inputProcessor.getGithubAPI;
		const headCommit = inputProcessor.getHeadCommit;
		const owner = inputProcessor.getOwner;
		const repo = inputProcessor.getRepo;
		const pullNumber = inputProcessor.getPullNumber;

		if (!headCommit) {
			throw new Error("Missing head commit information");
		}

		core.info("Adding review summary comment to pull request...");
		const commentBody = `${AI_REVIEW_COMMENT_PREFIX}${headCommit}${SUMMARY_SEPARATOR}${reviewSummary}`;
		await githubAPI.createPRComment(owner, repo, pullNumber, commentBody);

		const duration = Math.round((Date.now() - startTime) / 1000);
		core.info(`Code review completed successfully in ${duration} seconds`);
	} catch (error) {
		// Handle errors
		const errorMessage = error instanceof Error ? error.message : String(error);
		const stackTrace = error instanceof Error ? error.stack : undefined;

		// Log the error details for debugging
		if (stackTrace) core.debug(stackTrace);
		core.error(`Code review error: ${errorMessage}`);

		// Check if we should fail the action
		const failAction =
			core.getInput("fail_action_if_review_failed", { required: false }) ===
			"true";
		if (!failAction) {
			core.warning("Action is configured to continue despite errors");
		} else {
			core.setFailed(errorMessage);
		}
	}
};

// Run the action
main().catch((error) => {
	core.setFailed(
		`Unhandled error in main function: ${error instanceof Error ? error.message : String(error)}`,
	);
});
