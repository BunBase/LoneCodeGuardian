import { existsSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";

/**
 * Setup script to install dependencies before running the action
 */
async function setup(): Promise<void> {
	try {
		core.info("Starting setup for AI Code Review GitHub Action");
		core.info("Checking for package dependencies...");

		const pkgLockPath = join(import.meta.dir, "..", "bun.lock");
		const pkgJsonPath = join(import.meta.dir, "..", "package.json");

		if (!existsSync(pkgJsonPath)) {
			throw new Error(
				"package.json not found! This is required for the action to run.",
			);
		}

		if (!existsSync(pkgLockPath)) {
			core.warning(
				"Warning: bun.lock not found. For better security and reproducibility, consider using a lockfile.",
			);
		}

		core.info("Installing dependencies with Bun...");

		try {
			// Use Bun's spawn API to run the install command
			const proc = Bun.spawn(["bun", "install", "--production"], {
				cwd: join(import.meta.dir, ".."),
				stdout: "inherit",
				stderr: "inherit",
				env: { ...process.env },
			});

			// Wait for the process to complete
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				throw new Error(`Bun install failed with exit code ${exitCode}`);
			}

			core.info("Dependencies installed successfully");

			// Verify that critical dependencies are installed
			const criticalDeps = [
				"ai",
				"@ai-sdk/anthropic",
				"@ai-sdk/google",
				"zod",
				"@actions/core",
				"@actions/github",
			];
			for (const dep of criticalDeps) {
				try {
					// Try to resolve the dependency
					await import(dep);
				} catch (error) {
					core.warning(
						`Warning: Could not verify installation of ${dep}. This may cause issues during execution.`,
					);
				}
			}

			core.info("Setup completed successfully");
		} catch (error) {
			throw new Error(
				`Error running Bun install: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		core.setFailed(`Error during setup: ${errorMessage}`);
		process.exit(1);
	}
}

// Run the setup
setup().catch((error) => {
	const errorMessage = error instanceof Error ? error.message : String(error);
	core.setFailed(`Unhandled error in setup: ${errorMessage}`);
	process.exit(1);
});
