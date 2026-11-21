# pi-pr

A [pi](https://pi.dev) extension that shows the GitHub pull request attached to the current branch, similar to Copilot CLI's `/pr`.

<img width="1547" height="1044" alt="image" src="https://github.com/user-attachments/assets/8f7f6d3a-d584-4e18-a05d-eefb8b5b773e" />

## Install

```sh
pi install npm:pi-pr
# or straight from git
pi install git:github.com/chmouel/pi-pr
```

Requires the [`gh`](https://cli.github.com/) CLI, installed and authenticated.

## Footer

A status line below pi's footer, refreshed on session start and after each agent run:

```
●  PR #122 · 1 pending · review required ·   · +4084-17 · feat: Sync Vocabulary…
```

- CI state icon, then a clickable `PR #N` (OSC 8 hyperlink)
- CI summary, review decision, and per-reviewer state
- merge conflicts, diff size, then the PR title, truncated to fit the screen

Reviewer icons use [Nerd Font](https://www.nerdfonts.com/) Octicons: approved, changes requested, commented, requested, dismissed. Copilot is shown with its own icon.

## Commands

| Command | Description |
| --- | --- |
| `/pr` | PR summary table (state, branch, URL, changes, reviews, CI) |
| `/pr checks` | List each check with its result |
| `/pr open` | Open the PR in the browser |
| `/pr refresh` | Refresh the footer status |

The summary is shown in the transcript only and is not sent to the model.

## PR detection

It first asks `gh pr view`. When the branch tracks a fork but the PR was opened from another remote (for example pushed directly to the upstream repo), it falls back to `gh pr list --head <branch>`, preferring open PRs.

## License

Apache-2.0
