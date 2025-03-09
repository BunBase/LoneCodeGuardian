# LoneCodeGuardian - AI Code Review GitHub Action

A GitHub Action that performs automated code reviews on pull requests using AI models from Anthropic (Claude) or Google (Gemini).

## Features

- 🤖 Automated code review for pull requests
- 🔍 Identifies bugs, logic errors, security issues, and typos
- 🧠 Powered by state-of-the-art AI models (Claude or Gemini)
- 💬 Adds specific, actionable comments directly to the code
- 📊 Provides a summary of the review
- ⚙️ Configurable to include/exclude specific file types or paths
- 🔄 Supports incremental reviews

## Local Development and Testing

### Prerequisites

- [Bun](https://bun.sh/) installed
- API keys for the AI providers you want to use (Anthropic and/or Google)
- GitHub token for API access

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/LoneCodeGuardian.git
   cd LoneCodeGuardian
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create a `.env` file with your API keys:
   ```bash
   cp .env.example .env
   ```
   
   Then edit the `.env` file to add your API keys:
   ```
   GITHUB_TOKEN=your_github_token_here
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   GOOGLE_API_KEY=your_google_api_key_here
   ```

### Running Tests

Bun has a built-in test runner that we use for testing. You can run the tests in several ways:

#### Run All Tests

```bash
bun test
```

#### Run Specific Test Files

```bash
bun test test/schema.test.ts
bun test test/review-schema.test.ts
bun test test/input-processor.test.ts
```

#### Run Tests with Coverage

```bash
bun test --coverage
```

#### Run Tests in Watch Mode

```bash
bun test --watch
```

### Local Testing with Mock Data

To run a simulated GitHub Action environment with mock data:

```bash
bun run test:local
```

This will:
1. Load environment variables from your `.env` file
2. Mock the GitHub API and Action inputs
3. Run through the entire code review process
4. Display the review summary

### Testing with Real Data

To test with real data, you can modify the `test/mocks.ts` file to include real file content and changed files from a pull request.

## Configuration

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `token` | GitHub token with permissions to read and comment on pull requests | Yes | - |
| `ai_provider` | AI provider to use (anthropic or google) | Yes | `anthropic` |
| `anthropic_api_key` | Anthropic API key (required if using Anthropic provider) | No | - |
| `anthropic_model` | Anthropic model name | No | `claude-3-5-sonnet-20240620` |
| `google_api_key` | Google AI API key (required if using Google provider) | No | - |
| `google_model` | Google model name | No | `gemini-2.0-flash` |
| `owner` | Repository owner | Yes | - |
| `repo` | Repository name | Yes | - |
| `pr_number` | Pull request number | Yes | - |
| `include_extensions` | File extensions to include in the review (comma-separated, e.g., ".js,.ts,.py") | No | - |
| `exclude_extensions` | File extensions to exclude from the review (comma-separated) | No | - |
| `include_paths` | Paths to include in the review (comma-separated) | No | - |
| `exclude_paths` | Paths to exclude from review (comma-separated, e.g., "test/,docs/") | No | - |
| `fail_action_if_review_failed` | If set to true, the action fails when the review process fails | No | `false` |

## Example Usage

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  ai-code-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3
      
      - name: AI Code Review
        uses: your-username/LoneCodeGuardian@main
        with:
          repo: ${{ github.repository_name }}
          owner: ${{ github.repository_owner }}
          pr_number: ${{ github.event.pull_request.number }}
          token: ${{ secrets.GITHUB_TOKEN }}
          ai_provider: anthropic
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          anthropic_model: claude-3-sonnet-20240229
          include_extensions: .ts,.tsx,.js,.jsx
          exclude_extensions: .test.ts,.spec.ts
          include_paths: src/
          exclude_paths: node_modules/,dist/
```

## How It Works

1. The action retrieves the changed files in the pull request
2. It filters the files based on the configured include/exclude patterns
3. The AI model analyzes the code and identifies issues
4. The action adds comments directly to the pull request
5. A summary of the review is added as a comment on the pull request

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
