import * as core from "@actions/core";
import * as github from "@actions/github";
import {
	type ChangedFile,
	REVIEW_SIDES,
	type ReviewSide,
} from "../types/constants";

/**
 * GitHub API client for interacting with GitHub's REST API
 */
export class GitHubAPI {
	private octokit: ReturnType<typeof github.getOctokit>;

	/**
	 * Creates a new GitHubAPI instance
	 * @param token - GitHub token for authentication
	 */
	constructor(token: string) {
		this.octokit = github.getOctokit(token);
	}

	/**
	 * Generic method to fetch all paginated items
	 * @param method - API method that executes the request
	 * @param params - Parameters for the API method
	 * @returns Array of all items from all pages
	 */
	async getAllPaginatedItems<T>(
		method: (
			params: any,
		) => Promise<{ data: T[]; headers?: { link?: string } }>,
		params: Record<string, any>,
	): Promise<T[]> {
		const allItems: T[] = [];
		let page = 1;
		const perPage = 100;

		try {
			while (true) {
				const response = await method({
					...params,
					per_page: perPage,
					page: page,
				});

				const items = response.data;
				allItems.push(...items);

				const linkHeader = response.headers?.link;
				const hasNextPage = linkHeader && linkHeader.includes('rel="next"');

				if (!hasNextPage || items.length < perPage) {
					break;
				}

				page++;
			}

			return allItems;
		} catch (error) {
			core.error(
				`Error fetching paginated items: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Compares two commits.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param baseBranchName - The base branch name.
	 * @param headBranchName - The head branch name.
	 * @returns The comparison data.
	 */
	async compareCommits(
		owner: string,
		repo: string,
		baseBranchName: string,
		headBranchName: string,
	): Promise<any> {
		core.info(`Comparing commits: ${baseBranchName} -> ${headBranchName}`);
		try {
			const { data: diff } = await this.octokit.rest.repos.compareCommits({
				owner,
				repo,
				base: baseBranchName,
				head: headBranchName,
			});
			return diff;
		} catch (error) {
			core.error(
				`Error comparing commits: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Retrieves a pull request.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param prNumber - The pull request number.
	 * @returns The pull request data.
	 */
	async getPullRequest(
		owner: string,
		repo: string,
		prNumber: number,
	): Promise<any> {
		core.info(`Getting pull request #${prNumber}`);
		try {
			const { data: prData } = await this.octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: prNumber,
			});
			return prData;
		} catch (error) {
			core.error(
				`Error getting pull request: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Retrieves the content of a file.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param baseRef - The reference (branch or commit SHA) to old file version.
	 * @param actualRef - The reference (branch or commit SHA) to new file version.
	 * @param filePath - The file path.
	 * @returns The file content.
	 */
	async getContent(
		owner: string,
		repo: string,
		baseRef: string,
		actualRef: string,
		filePath: string,
	): Promise<string> {
		core.info(`Getting content: ${filePath} (${baseRef} -> ${actualRef})`);

		try {
			// First try to get the file content directly
			try {
				const { data: fileMetadata } = await this.octokit.rest.repos.getContent(
					{
						owner,
						repo,
						path: filePath,
						ref: actualRef,
					},
				);

				if (Array.isArray(fileMetadata)) {
					core.warning(`Path ${filePath} is a directory, not a file`);
					return `[Directory not shown]`;
				}

				if ((fileMetadata as any).type !== "file") {
					core.warning(
						`Path ${filePath} is not a file (type: ${(fileMetadata as any).type})`,
					);
					return `[${(fileMetadata as any).type} not shown]`;
				}

				// Check if the file has content
				if (
					(fileMetadata as any).content &&
					(fileMetadata as any).encoding === "base64"
				) {
					const content = Buffer.from(
						(fileMetadata as any).content,
						"base64",
					).toString("utf-8");
					core.info(
						`Successfully retrieved content for ${filePath} (${content.length} characters)`,
					);
					return content;
				}

				// If we have a download URL, try to fetch the content directly
				if ((fileMetadata as any).download_url) {
					core.info(
						`Fetching content from download URL: ${(fileMetadata as any).download_url}`,
					);
					const response = await fetch((fileMetadata as any).download_url);
					if (response.ok) {
						const content = await response.text();
						core.info(
							`Successfully retrieved content from download URL for ${filePath} (${content.length} characters)`,
						);
						return content;
					} else {
						core.warning(
							`Failed to fetch content from download URL: ${response.status} ${response.statusText}`,
						);
					}
				}
			} catch (error) {
				core.warning(
					`Error getting content with getContent API: ${error instanceof Error ? error.message : String(error)}`,
				);
				// Continue to try alternative methods
			}

			// If direct content retrieval fails, try to get the raw content using the raw URL
			try {
				const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${actualRef}/${filePath}`;
				core.info(`Trying to fetch content from raw URL: ${rawUrl}`);
				const response = await fetch(rawUrl);
				if (response.ok) {
					const content = await response.text();
					core.info(
						`Successfully retrieved content from raw URL for ${filePath} (${content.length} characters)`,
					);
					return content;
				} else {
					core.warning(
						`Failed to fetch content from raw URL: ${response.status} ${response.statusText}`,
					);
				}
			} catch (error) {
				core.warning(
					`Error getting content from raw URL: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			// If all else fails, try to get the content from the diff
			try {
				core.info(`Trying to extract content from diff for ${filePath}`);
				const { data: comparison } =
					await this.octokit.rest.repos.compareCommits({
						owner,
						repo,
						base: baseRef,
						head: actualRef,
					});

				const fileInfo = comparison.files?.find(
					(file: any) => file.filename === filePath,
				);

				if (fileInfo && fileInfo.patch) {
					core.info(`Found patch for ${filePath} in diff`);
					// Extract content from patch (this is a simplified approach)
					const lines = fileInfo.patch
						.split("\n")
						.filter(
							(line: string) => !line.startsWith("-") && !line.startsWith("@@"),
						)
						.map((line: string) =>
							line.startsWith("+") ? line.substring(1) : line,
						);

					const content = lines.join("\n");
					core.info(
						`Extracted content from patch for ${filePath} (${content.length} characters)`,
					);
					return content;
				} else {
					core.warning(`No patch found for ${filePath} in diff`);
				}
			} catch (error) {
				core.warning(
					`Error extracting content from diff: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} catch (error) {
			core.error(
				`Error getting content for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		core.warning(`All methods to retrieve content for ${filePath} failed`);
		return "[File content unavailable]";
	}

	/**
	 * Creates a comment on a pull request.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param prNumber - The pull request number.
	 * @param body - The comment body.
	 */
	async createPRComment(
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<void> {
		core.info(`Creating PR comment on #${prNumber}`);
		try {
			await this.octokit.rest.issues.createComment({
				owner,
				repo,
				issue_number: prNumber,
				body,
			});
			core.info("PR comment created successfully");
		} catch (error) {
			core.error(
				`Error creating PR comment: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Creates a review comment on a pull request.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param prNumber - The pull request number.
	 * @param commitId - The commit ID.
	 * @param body - The comment body.
	 * @param path - The relative path to the file that necessitates a comment.
	 * @param side - In a split diff view, the side of the diff that the pull request's changes appear on.
	 * @param startLine - The start line number.
	 * @param line - The line number.
	 */
	async createReviewComment(
		owner: string,
		repo: string,
		prNumber: number,
		commitId: string,
		body: string,
		path: string,
		side: ReviewSide,
		startLine: number,
		line: number,
	): Promise<void> {
		core.info(
			`Creating review comment on ${path} (${side}, lines ${startLine}-${line})`,
		);

		try {
			if (startLine === line) {
				core.info(`Creating single line comment for line ${startLine}`);
				await this.octokit.rest.pulls.createReviewComment({
					owner,
					repo,
					pull_number: prNumber,
					body,
					commit_id: commitId,
					path,
					side,
					line: startLine,
				});
			} else {
				core.info(`Creating multi-line comment for lines ${startLine}-${line}`);
				await this.octokit.rest.pulls.createReviewComment({
					owner,
					repo,
					pull_number: prNumber,
					body,
					commit_id: commitId,
					path,
					start_side: side,
					side,
					start_line: startLine,
					line,
				});
			}
			core.info("Review comment created successfully");
		} catch (error) {
			core.error(
				`Error creating review comment: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Lists all comments in a pull request with pagination support.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param prNumber - The pull request number.
	 * @returns The list of all comments.
	 */
	async listPRComments(
		owner: string,
		repo: string,
		prNumber: number,
	): Promise<any[]> {
		core.info(`Listing PR comments for #${prNumber}`);
		try {
			return await this.getAllPaginatedItems(
				this.octokit.rest.issues.listComments,
				{ owner, repo, issue_number: prNumber },
			);
		} catch (error) {
			core.error(
				`Error listing PR comments: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Gets all commits in a pull request with pagination support.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param prNumber - The pull request number.
	 * @returns The list of all commits.
	 */
	async listPRCommits(
		owner: string,
		repo: string,
		prNumber: number,
	): Promise<any[]> {
		core.info(`Listing PR commits for #${prNumber}`);
		try {
			return await this.getAllPaginatedItems(
				this.octokit.rest.pulls.listCommits,
				{ owner, repo, pull_number: prNumber },
			);
		} catch (error) {
			core.error(
				`Error listing PR commits: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}

	/**
	 * Gets changed files between two commits.
	 * @param owner - The repository owner.
	 * @param repo - The repository name.
	 * @param baseCommit - The base commit SHA.
	 * @param headCommit - The head commit SHA.
	 * @returns The list of changed files.
	 */
	async getFilesBetweenCommits(
		owner: string,
		repo: string,
		baseCommit: string,
		headCommit: string,
	): Promise<ChangedFile[]> {
		core.info(
			`Getting files between commits: ${baseCommit.substring(0, 7)} -> ${headCommit.substring(0, 7)}`,
		);
		try {
			const { data: comparison } = await this.octokit.rest.repos.compareCommits(
				{
					owner,
					repo,
					base: baseCommit,
					head: headCommit,
				},
			);
			return comparison.files || [];
		} catch (error) {
			core.error(
				`Error getting files between commits: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}
}
