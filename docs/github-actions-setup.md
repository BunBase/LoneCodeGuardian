## Repository Permissions

To allow GitHub Actions to comment on pull requests, you need to configure the repository settings:

1. Go to your repository on GitHub
2. Click on "Settings"
3. In the left sidebar, click on "Actions" under "Code and automation"
4. Scroll down to "Workflow permissions"
5. Select "Read and write permissions"
6. Check "Allow GitHub Actions to create and approve pull requests"
7. Click "Save"

Additionally, make sure to explicitly pass the GitHub token in your workflow:

```yaml
- name: AI Code Review
  uses: your-username/LoneCodeGuardian@main
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    # Other inputs...
```

This ensures that the token is properly accessible to the action.

## Troubleshooting

If you encounter issues with the GitHub Actions workflows:

1. Check the workflow run logs in the "Actions" tab
2. Verify that all required secrets are set correctly
3. Ensure the repository permissions are configured as described above
4. Make sure you're explicitly passing the GitHub token as `token: ${{ secrets.GITHUB_TOKEN }}`
5. Check that the PR number provided is valid
6. Verify that the AI provider API keys are valid and have sufficient quota 