import * as core from "@actions/core";
import { z } from "zod";
import type { AIAgent } from "../ai/ai-agent";
import { AnthropicAgent } from "../ai/anthropic-agent";
import { GoogleAgent } from "../ai/google-agent";
import { GitHubAPI } from "../github/github-api";
import {
	type AIProvider,
	AI_REVIEW_COMMENT_PREFIX,
	type ChangedFile,
	type FileCommentator,
	type FileContentGetter,
	type ReviewSide,
	SUMMARY_SEPARATOR,
	SUPPORTED_PROVIDERS,
} from "../types/constants";

/**
 * Schema for GitHub Action inputs
 */
const ActionInputSchema = z.object({
	repo: z.string().min(1, "Repository name is required"),
	owner: z.string().min(1, "Owner name is required"),
	pr_number: z.coerce
		.number()
		.int()
		.positive("Pull request number must be a valid positive number"),
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
	token: z.string().optional(),
});

type ActionInputs = z.infer<typeof ActionInputSchema>;

/**
 * Processes inputs from GitHub Actions and prepares for code review
 */
export class InputProcessor {
	private repo: string;
	private owner: string;
	private pullNumber: number;
	private githubToken: string;
	private aiProvider: AIProvider;
	private apiKey: string;
	private model: string;
	private failAction: boolean;
	private githubAPI: GitHubAPI;
	private baseCommit?: string;
	private headCommit?: string;
	private filteredDiffs: ChangedFile[] = [];
	private fileContentGetter?: FileContentGetter;
	private fileCommentator?: FileCommentator;
	private includeExtensions?: string;
	private excludeExtensions?: string;
	private includePaths?: string;
	private excludePaths?: string;

	/**
	 * Creates a new InputProcessor instance
	 * @param inputs - Validated inputs from GitHub Actions
	 */
	private constructor(inputs: ActionInputs) {
		this.repo = inputs.repo;
		this.owner = inputs.owner;
		this.pullNumber = inputs.pr_number;

		// Get GitHub token from inputs or environment
		// GitHub Actions provides the token as secrets.GITHUB_TOKEN or github.token
		this.githubToken =
			inputs.token || process.env.GITHUB_TOKEN || process.env.INPUT_TOKEN || "";

		if (!this.githubToken) {
			core.warning("GitHub token not found. Using empty token.");
			core.warning(
				"Make sure to pass the token as an input: token: ${{ secrets.GITHUB_TOKEN }}",
			);
			core.warning("And ensure the workflow has the correct permissions set:");
			core.warning("permissions:");
			core.warning("  contents: read");
			core.warning("  pull-requests: write");
		} else {
			core.info("GitHub token found.");
		}

		this.aiProvider = inputs.ai_provider;
		this.apiKey = inputs.api_key;
		this.model = inputs.model;
		this.failAction = inputs.fail_action_if_review_failed;
		this.includeExtensions = inputs.include_extensions;
		this.excludeExtensions = inputs.exclude_extensions;
		this.includePaths = inputs.include_paths;
		this.excludePaths = inputs.exclude_paths;
		this.githubAPI = new GitHubAPI(this.githubToken);

		// Log configuration
		core.info("Configuration:");
		core.info(`- Repository: ${this.owner}/${this.repo}`);
		core.info(`- Pull Request: #${this.pullNumber}`);
		core.info(`- AI Provider: ${this.aiProvider}`);
		core.info(`- AI Model: ${this.model}`);
		core.info(`- Fail on Review Error: ${this.failAction}`);

		if (!this.includeExtensions) core.info("- Include Extensions: [all]");
		else core.info(`- Include Extensions: ${this.includeExtensions}`);

		if (!this.excludeExtensions) core.info("- Exclude Extensions: [none]");
		else core.info(`- Exclude Extensions: ${this.excludeExtensions}`);

		if (!this.includePaths) core.info("- Include Paths: [all]");
		else core.info(`- Include Paths: ${this.includePaths}`);

		if (!this.excludePaths) core.info("- Exclude Paths: [none]");
		else core.info(`- Exclude Paths: ${this.excludePaths}`);
	}

	/**
	 * Create a new InputProcessor instance from GitHub Actions inputs
	 * @returns A new InputProcessor instance
	 */
	static async create(): Promise<InputProcessor> {
		try {
			// Read raw inputs from GitHub Actions
			const rawInputs = {
				repo: core.getInput("repo", { required: true, trimWhitespace: true }),
				owner: core.getInput("owner", { required: true, trimWhitespace: true }),
				pr_number: core.getInput("pr_number", {
					required: true,
					trimWhitespace: true,
				}),
				ai_provider: core.getInput("ai_provider", {
					required: true,
					trimWhitespace: true,
				}),
				api_key: "",
				model: "",
				fail_action_if_review_failed: core.getInput(
					"fail_action_if_review_failed",
					{ required: false, trimWhitespace: true },
				),
				include_extensions: core.getInput("include_extensions", {
					required: false,
				}),
				exclude_extensions: core.getInput("exclude_extensions", {
					required: false,
				}),
				include_paths: core.getInput("include_paths", { required: false }),
				exclude_paths: core.getInput("exclude_paths", { required: false }),
				token: core.getInput("token", { required: false }),
			};

			// Get provider-specific inputs
			const providerId = rawInputs.ai_provider;
			if (SUPPORTED_PROVIDERS.includes(providerId as AIProvider)) {
				rawInputs.api_key = core.getInput(`${providerId}_api_key`, {
					required: true,
					trimWhitespace: true,
				});
				rawInputs.model = core.getInput(`${providerId}_model`, {
					required: true,
					trimWhitespace: true,
				});
			}

			// Validate and transform inputs using Zod schema
			const result = ActionInputSchema.safeParse({
				...rawInputs,
				fail_action_if_review_failed:
					rawInputs.fail_action_if_review_failed.toLowerCase() === "true",
			});

			if (!result.success) {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n");
				throw new Error(`Input validation failed:\n${errorMessages}`);
			}

			core.info("Input validation successful");
			return new InputProcessor(result.data);
		} catch (error) {
			throw new Error(
				`Error processing inputs: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Process inputs from GitHub Actions and prepare for code review
	 * @returns This instance for chaining
	 */
	async processInputs(): Promise<InputProcessor> {
		await this.setupGitHubAPI();
		await this.processChangedFiles();
		this.setupReviewTools();
		return this;
	}

	/**
	 * Set up GitHub API client and retrieve PR data
	 * @throws Error if GitHub information is missing
	 */
	private async setupGitHubAPI(): Promise<void> {
		try {
			const pullRequestData = await this.githubAPI.getPullRequest(
				this.owner,
				this.repo,
				this.pullNumber,
			);

			if (!pullRequestData || !pullRequestData.head || !pullRequestData.base) {
				throw new Error(
					`Failed to get pull request data for PR #${this.pullNumber}`,
				);
			}

			this.headCommit = pullRequestData.head.sha;
			this.baseCommit = pullRequestData.base.sha;

			core.info(`Pull request base commit: ${this.baseCommit}`);
			core.info(`Pull request head commit: ${this.headCommit}`);
		} catch (error) {
			throw new Error(
				`Error setting up GitHub API: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Process changed files to find files to review
	 * @throws Error if GitHub API or commit information is not available
	 */
	private async processChangedFiles(): Promise<void> {
		if (!this.baseCommit || !this.headCommit) {
			throw new Error("GitHub API or commit information not available");
		}

		try {
			const comments = await this.githubAPI.listPRComments(
				this.owner,
				this.repo,
				this.pullNumber,
			);
			const lastReviewComment = [...comments]
				.reverse()
				.find((comment) => comment?.body?.startsWith(AI_REVIEW_COMMENT_PREFIX));

			if (lastReviewComment?.body) {
				core.info(
					`Found last review comment: ${lastReviewComment.body.split("\n")[0]}`,
				);

				let newBaseCommit = lastReviewComment.body
					.split(SUMMARY_SEPARATOR)[0]
					.replace(AI_REVIEW_COMMENT_PREFIX, "")
					.trim();

				if (newBaseCommit && newBaseCommit.trim() !== "") {
					newBaseCommit = newBaseCommit.split(" ")[0];
					core.info(
						`New base commit ${newBaseCommit}. Incremental review will be performed`,
					);
					this.baseCommit = newBaseCommit;
				}
			} else {
				core.info(
					"No previous review comments found, reviewing all files in PR",
				);
			}

			const changedFiles = await this.githubAPI.getFilesBetweenCommits(
				this.owner,
				this.repo,
				this.baseCommit || "",
				this.headCommit,
			);

			if (!changedFiles || changedFiles.length === 0) {
				core.info("No changed files found between the base and head commits");
			} else {
				core.info(
					`Found ${changedFiles.length} changed files before filtering`,
				);
			}

			this.filteredDiffs = this.getFilteredChangedFiles(
				changedFiles,
				this.includeExtensions,
				this.excludeExtensions,
				this.includePaths,
				this.excludePaths,
			);

			core.info(
				`Found ${this.filteredDiffs.length} files to review after filtering`,
			);

			if (this.filteredDiffs.length > 0) {
				core.info("Files to review:");
				for (const file of this.filteredDiffs) {
					core.info(
						`- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`,
					);
				}
			}
		} catch (error) {
			throw new Error(
				`Error processing changed files: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Filter changed files based on extension and path criteria
	 * @param changedFiles - List of changed files
	 * @param includeExtensions - Extensions to include
	 * @param excludeExtensions - Extensions to exclude
	 * @param includePaths - Paths to include
	 * @param excludePaths - Paths to exclude
	 * @returns Filtered list of changed files
	 */
	private getFilteredChangedFiles(
		changedFiles: ChangedFile[],
		includeExtensions?: string,
		excludeExtensions?: string,
		includePaths?: string,
		excludePaths?: string,
	): ChangedFile[] {
		const stringToArray = (inputString?: string): string[] => {
			if (!inputString) return [];
			return inputString
				.split(",")
				.map((item) => {
					const normalized = item.trim().replace(/\\/g, "/");
					if (normalized.startsWith(".")) {
						return normalized;
					}
					return normalized.endsWith("/") ? normalized : `${normalized}/`;
				})
				.filter(Boolean);
		};

		const includeExtensionsArray = stringToArray(includeExtensions);
		const excludeExtensionsArray = stringToArray(excludeExtensions);
		const includePathsArray = stringToArray(includePaths);
		const excludePathsArray = stringToArray(excludePaths);

		const isFileToReview = (filename: string): boolean => {
			const normalizedFilename = filename.replace(/\\/g, "/");

			const hasValidExtension =
				includeExtensionsArray.length === 0 ||
				includeExtensionsArray.some((ext) => normalizedFilename.endsWith(ext));
			const hasExcludedExtension =
				excludeExtensionsArray.length > 0 &&
				excludeExtensionsArray.some((ext) => normalizedFilename.endsWith(ext));

			const isInIncludedPath =
				includePathsArray.length === 0 ||
				includePathsArray.some((path) => normalizedFilename.startsWith(path));
			const isInExcludedPath =
				excludePathsArray.length > 0 &&
				excludePathsArray.some((path) => normalizedFilename.startsWith(path));

			return (
				hasValidExtension &&
				!hasExcludedExtension &&
				isInIncludedPath &&
				!isInExcludedPath
			);
		};

		return changedFiles.filter((file) =>
			isFileToReview(file.filename.replace(/\\/g, "/")),
		);
	}

	/**
	 * Set up file content getter and commentator functions
	 * @throws Error if GitHub API or commit information is not available
	 */
	private setupReviewTools(): void {
		if (!this.baseCommit || !this.headCommit) {
			throw new Error("GitHub API or commit information not available");
		}

		// Set up file content getter
		this.fileContentGetter = async (filePath: string): Promise<string> => {
			try {
				core.info(`Getting content for file: ${filePath}`);

				if (!this.baseCommit || !this.headCommit) {
					throw new Error("Missing commit information");
				}

				const content = await this.githubAPI.getContent(
					this.owner,
					this.repo,
					this.baseCommit,
					this.headCommit,
					filePath,
				);

				if (content === "[File content unavailable]") {
					core.warning(
						`Could not retrieve content for ${filePath}. This may affect the quality of the review.`,
					);
				} else {
					core.info(
						`Successfully retrieved content for ${filePath} (${content.length} characters)`,
					);
				}

				return content;
			} catch (error) {
				core.error(
					`Error getting file content for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return `[Error retrieving file content: ${error instanceof Error ? error.message : String(error)}]`;
			}
		};

		// Set up file commentator
		this.fileCommentator = async (
			comment: string,
			filePath: string,
			side: ReviewSide,
			startLineNumber: number,
			endLineNumber: number,
		): Promise<void> => {
			try {
				core.info(
					`Adding review comment to ${filePath} at lines ${startLineNumber}-${endLineNumber} (side: ${side})`,
				);

				// Validate inputs
				if (!comment || comment.trim() === "") {
					throw new Error("Comment text cannot be empty");
				}

				if (!filePath || filePath.trim() === "") {
					throw new Error("File path cannot be empty");
				}

				if (!this.headCommit) {
					throw new Error("Head commit information not available");
				}

				if (startLineNumber < 1 || endLineNumber < startLineNumber) {
					throw new Error(
						`Invalid line numbers: ${startLineNumber}-${endLineNumber}`,
					);
				}

				// Add the comment
				await this.githubAPI.createReviewComment(
					this.owner,
					this.repo,
					this.pullNumber,
					this.headCommit,
					comment,
					filePath,
					side,
					startLineNumber,
					endLineNumber,
				);

				core.info(`Successfully added review comment to ${filePath}`);
			} catch (error) {
				core.error(
					`Error adding review comment to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
				throw error;
			}
		};
	}

	/**
	 * Get the appropriate AI agent based on provider
	 * @returns AI agent
	 * @throws Error if required settings are missing
	 */
	getAIAgent(): AIAgent {
		if (!this.fileContentGetter || !this.fileCommentator) {
			throw new Error("Required settings are missing");
		}

		switch (this.aiProvider) {
			case "anthropic":
				return new AnthropicAgent(
					this.apiKey,
					this.fileContentGetter,
					this.fileCommentator,
					this.model,
				);
			case "google":
				return new GoogleAgent(
					this.apiKey,
					this.fileContentGetter,
					this.fileCommentator,
					this.model,
				);
			default:
				throw new Error(`Unsupported AI provider: ${this.aiProvider}`);
		}
	}

	/**
	 * Getters for properties
	 */
	get getFilteredDiffs(): ChangedFile[] {
		return this.filteredDiffs;
	}

	get getGithubAPI(): GitHubAPI {
		return this.githubAPI;
	}

	get getHeadCommit(): string | undefined {
		return this.headCommit;
	}

	get getRepo(): string {
		return this.repo;
	}

	get getOwner(): string {
		return this.owner;
	}

	get getPullNumber(): number {
		return this.pullNumber;
	}

	get getFailAction(): boolean {
		return this.failAction;
	}
}
