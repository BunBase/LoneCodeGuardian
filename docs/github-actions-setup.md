# Setting Up GitHub Actions for LoneCodeGuardian

This guide explains how to set up your repository to use the GitHub Actions workflows included in this project.

## Repository Permissions

To allow GitHub Actions to comment on pull requests, you need to configure the repository settings:

1. Go to your repository on GitHub
2. Click on "Settings"
3. In the left sidebar, click on "Actions" under "Code and automation"
4. Scroll down to "Workflow permissions"
5. Select "Read and write permissions"
6. Check "Allow GitHub Actions to create and approve pull requests"
7. Click "Save"

## Required Secrets

The GitHub Actions workflows require the following secrets to be set in your repository:

1. `ANTHROPIC_API_KEY` - Your Anthropic API key (for Claude)
2. `GOOGLE_API_KEY` - Your Google API key (if using Gemini)

To add these secrets:

1. Go to your repository on GitHub
2. Click on "Settings"
3. In the left sidebar, click on "Secrets and variables" under "Security"
4. Click on "Actions"
5. Click on "New repository secret"
6. Add each secret with its name and value
7. Click "Add secret"

## Available Workflows

### Self Code Review

This workflow automatically runs the AI code review action on pull requests to your repository.

- File: `.github/workflows/self-review.yml`
- Triggers: When PRs are opened, synchronized, or reopened
- Provider: Uses Anthropic (Claude) by default

### Test Action

This workflow allows manual testing of the action on specific PRs.

- File: `.github/workflows/test-action.yml`
- Triggers: 
  - Manual trigger with a PR number
  - Automatic run every day at midnight on the latest PR
- Usage: Go to the "Actions" tab, select "Test AI Code Review Action", and click "Run workflow". Enter the PR number you want to review.

### Test Suite

This workflow runs the test suite to ensure the action is working correctly.

- File: `.github/workflows/test-suite.yml`
- Triggers: Pushes to main/master and pull requests
- Actions: Runs the test suite and verifies the build

## Troubleshooting

If you encounter issues with the GitHub Actions workflows:

1. Check the workflow run logs in the "Actions" tab
2. Verify that all required secrets are set correctly
3. Ensure the repository permissions are configured as described above
4. Check that the PR number provided is valid
5. Verify that the AI provider API keys are valid and have sufficient quota 