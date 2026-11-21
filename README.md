# pi-pr

A [pi](https://pi.dev) extension that shows the GitHub pull request for the current branch, like Copilot CLI's `/pr`.

<img width="1547" height="1044" alt="screenshot of the footer status and /pr table" src="https://github.com/user-attachments/assets/8f7f6d3a-d584-4e18-a05d-eefb8b5b773e" />

## Install

```sh
pi install npm:@chmouel/pi-pr
pi install git:github.com/chmouel/pi-pr   # straight from git
```

You need the [`gh`](https://cli.github.com/) CLI installed and authenticated.

## What you get

A status line under pi's footer, refreshed when a session starts and after each agent run:

```
●  PR #122 · 1 pending · review required ·   · +4084-17 · feat: Sync Vocabulary…
```

The line carries the CI state, a clickable `PR #N` (OSC 8 hyperlink), the CI tally, the review decision, each reviewer's state, merge conflicts, the diff size, and the PR title. The title sits last, so it is the part pi truncates when the terminal is narrow.

Reviewer states use [Nerd Font](https://www.nerdfonts.com/) Octicons for approved, changes requested, commented, requested and dismissed. Copilot gets its own glyph.

## Commands

| Command | Does |
| --- | --- |
| `/pr` | Print a summary table: state, branch, URL, changes, reviews, CI |
| `/pr checks` | Print each check with its result |
| `/pr open` | Open the PR in the browser |
| `/pr refresh` | Refresh the footer status |

The summary lands in the transcript as a card. It is not sent to the model.

## Finding the PR

`gh pr view` answers first. If it reports no PR, the extension falls back to `gh pr list --head <branch>`, which finds a PR opened from a different remote than the one the branch tracks. That case shows up when you push straight to the upstream repository while the branch tracks your fork.

## Similar packages

| Package | Scope |
| --- | --- |
| `@narumitw/pi-github-pr` | Shows PR review, check and comment status. Closest overlap with this extension. |
| `@henryqw/pi-pr` | `/pr` command that finds, creates, updates and merges PRs, then fixes CI from review feedback. |
| `pi-prs` | Pulls review feedback into the agent and watches PRs. |
| `@pikibun/pi-pr-flow` | Drives a change through the PR lifecycle, draft first, ready later. |
| `@sfroment/pi-gh-cli`, `@procedures/gh` | Wrap the `gh` CLI as tools, no PR status line. |

Use this one for the footer status, the transcript table and the fork-aware lookup. Use `@henryqw/pi-pr` if you want the agent to act on the PR rather than display it.

## Release

Publishing runs on [trusted publishing](https://docs.npmjs.com/trusted-publishers/): GitHub Actions authenticates with OIDC and no npm token is stored anywhere.

```sh
npm version patch && git push --follow-tags
```

The `v*` tag starts `.github/workflows/publish.yml`, which skips versions already on the registry.

## License

Apache-2.0
