# Developer notes

## Releasing

Publishing runs on [trusted publishing](https://docs.npmjs.com/trusted-publishers/). GitHub Actions authenticates with OIDC and no npm token is stored anywhere.

```sh
npm version patch && git push --follow-tags
```

The `v*` tag starts `.github/workflows/publish.yml`. The workflow skips a version that is already on the registry, so re-running a tag stays green.

The trusted publisher on npmjs.com is bound to user `chmouel`, repository `pi-pr` and workflow filename `publish.yml`. A mismatch on any of the three is why a CI publish fails with `ENEEDAUTH`.

## Updating the installed copy

The extension is loaded from `~/.pi/agent/extensions/pr.ts` when installed locally, and from the npm package when installed with `pi install`. Edits made in this repo only reach a local install if you copy the file over:

```sh
cp extensions/pr.ts ~/.pi/agent/extensions/pr.ts
```

Then run `/reload` inside pi.

## Layout

`extensions/pr.ts` is the whole extension: the `/pr` command, the transcript card renderer, and the footer status. No build step, no dependencies beyond the pi host packages.
