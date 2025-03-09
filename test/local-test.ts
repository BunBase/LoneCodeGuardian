import "dotenv/config";
import type { AnnotationProperties, InputOptions } from "@actions/core";
import { mockInputs, setupMocks } from "./mocks";

// Setup mocks
setupMocks();

/**
 * Run the test
 */
async function runTest() {
	console.log("🧪 Starting local test of AI Code Review");

	try {
		// Import the modules we need
		// In a real test, we would use proper mocking, but for this example
		// we'll just use the actual implementation with our mock data
		const { InputProcessor } = await import("../src/config/input-processor");

		// Monkey patch the core module for testing
		// This is not ideal but works for our simple test
		const originalCoreModule = await import("@actions/core");
		const originalGetInput = originalCoreModule.getInput;
		originalCoreModule.getInput = (name: string, options?: InputOptions) =>
			mockInputs[name] || "";
		originalCoreModule.info = (
			message: string | Error,
			properties?: AnnotationProperties,
		) =>
			console.log(
				`[INFO] ${message instanceof Error ? message.message : message}`,
			);
		originalCoreModule.warning = (
			message: string | Error,
			properties?: AnnotationProperties,
		) =>
			console.log(
				`[WARNING] ${message instanceof Error ? message.message : message}`,
			);
		originalCoreModule.error = (
			message: string | Error,
			properties?: AnnotationProperties,
		) =>
			console.log(
				`[ERROR] ${message instanceof Error ? message.message : message}`,
			);

		// Create and process inputs
		console.log("📝 Creating InputProcessor...");
		const inputProcessor = await InputProcessor.create();
		console.log("✅ InputProcessor created successfully");

		console.log("🔄 Processing inputs...");
		await inputProcessor.processInputs();
		console.log("✅ Inputs processed successfully");

		// Get AI agent and run review
		console.log("🤖 Getting AI agent...");
		const aiAgent = inputProcessor.getAIAgent();
		console.log(`✅ Using ${mockInputs.ai_provider} AI agent`);

		console.log("🔍 Starting code review...");
		console.log(`📄 Reviewing ${inputProcessor.getFilteredDiffs.length} files`);

		const reviewSummary = await aiAgent.doReview(
			inputProcessor.getFilteredDiffs,
		);

		console.log("\n📊 Review Summary:");
		console.log("=================");
		console.log(reviewSummary);
		console.log("=================");

		console.log("✅ Test completed successfully");

		// Restore original functions
		originalCoreModule.getInput = originalGetInput;
	} catch (error) {
		console.error("❌ Test failed:", error);
		if (error instanceof Error) {
			console.error("Error message:", error.message);
			console.error("Stack trace:", error.stack);
		}
	}
}

// Run the test
runTest();
