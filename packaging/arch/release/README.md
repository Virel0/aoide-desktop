# Aoide as a pacman repository

Every tagged release (`v1.2.3`) is built by CI into a pacman package and
published on the GitHub release together with a repository database. Add the
repository once and Aoide upgrades with the rest of the system:

```ini
# /etc/pacman.conf
[aoide]
SigLevel = Optional TrustAll
Server = https://github.com/Virel0/aoide-desktop/releases/latest/download
```

then

```sh
sudo pacman -Syu aoide
```

`SigLevel = Optional TrustAll` is there because the packages are not signed;
the download itself is over HTTPS from GitHub. This needs the repository to be
public, because pacman fetches without credentials.

Cutting a release: push a tag.

```sh
git tag v1.15.2 && git push origin v1.15.2
```

The workflow in `.github/workflows/release-arch.yml` does the rest. The app also
watches this repository's releases and offers the update from inside Aoide.

## Finishing a release

Pushing the tag builds the pacman package and creates the release. The Flatpak
bundle is a second step, because GitHub will not start one workflow from a
release another workflow's token created — the loop that rule prevents is a real
one. On the repository's Actions page, run **Flatpak** and give it the tag; it
builds `aoide.flatpak` and attaches it to that release.
