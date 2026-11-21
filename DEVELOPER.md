# Developer notes

## Releasing

Publishing runs on [trusted publishing](https://docs.npmjs.com/trusted-publishers/). GitHub Actions authenticates with OIDC and no npm token is stored anywhere.

```sh
npm version patch && git push --follow-tags
```

The `v*` tag starts `.github/workflows/publish.yml`. The workflow skips a version that is already on the registry, so re-running a tag stays green.

The trusted publisher on npmjs.com is bound to user `chmouel`, repository `pi-pr` and workflow filename `publish.yml`. A mismatch on any of the three is why a CI publish fails with `ENEEDAUTH`.

## Working on it

The extension is installed from npm, so pi loads the published file:

```sh
pi install npm:@chmouel/pi-pr
pi update --extensions        # after a release
```

To test a change before releasing it, install the checkout instead. Pi loads the local path directly and picks up edits on `/reload`:

```sh
pi uninstall npm:@chmouel/pi-pr
pi install ~/git/perso/pi-pr
```

Swapping back afterwards means removing the local source from `packages` in `~/.pi/agent/settings.json` and installing the npm one again.

## Layout

`extensions/pr.ts` is the whole extension: the `/pr` command, the transcript card renderer, and the footer status. No build step, no dependencies beyond the pi host packages.
