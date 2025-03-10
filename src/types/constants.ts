/**
 * Common constants used across the application
 */

// Comment prefix used to identify AI review comments
export const AI_REVIEW_COMMENT_PREFIX = "AI review done up to commit: ";

// Separator for the summary section in review comments
export const SUMMARY_SEPARATOR = "\n\n### AI Review Summary:\n";

// Supported AI providers
export const SUPPORTED_PROVIDERS = ["anthropic", "google"] as const;
export type AIProvider = (typeof SUPPORTED_PROVIDERS)[number];

// Tool names used in the application
export const TOOL_NAMES = {
	GET_FILE_CONTENT: "get_file_content",
	ADD_REVIEW_COMMENT: "add_review_comment",
	MARK_AS_DONE: "mark_as_done",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// Review side for comments (LEFT for deletions, RIGHT for additions)
export const REVIEW_SIDES = {
	LEFT: "LEFT",
	RIGHT: "RIGHT",
} as const;

export type ReviewSide = (typeof REVIEW_SIDES)[keyof typeof REVIEW_SIDES];

// GitHub file status
export const FILE_STATUSES = {
	ADDED: "added",
	MODIFIED: "modified",
	REMOVED: "removed",
	RENAMED: "renamed",
	COPIED: "copied",
	CHANGED: "changed",
	UNCHANGED: "unchanged",
} as const;

export type FileStatus = (typeof FILE_STATUSES)[keyof typeof FILE_STATUSES];

// ChangedFile interface representing a file that was changed in a PR
export interface ChangedFile {
	filename: string;
	status: FileStatus;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
}

// Type for the function that gets file content
export type FileContentGetter = (filePath: string) => Promise<string>;

// Type for the function that adds a review comment
export type FileCommentator = (
	comment: string,
	filePath: string,
	side: ReviewSide,
	startLineNumber: number,
	endLineNumber: number,
) => Promise<void>;

// Tool call interfaces
export interface GetFileContentArgs {
	path_to_file: string;
	start_line_number: number;
	end_line_number: number;
}

export interface AddReviewCommentArgs {
	file_name: string;
	start_line_number: number;
	end_line_number: number;
	found_error_description: string;
	side?: ReviewSide;
}

export interface MarkAsDoneArgs {
	brief_summary: string;
}
