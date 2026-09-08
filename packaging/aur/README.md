# Publishing Aoide to the AUR

`aoide-git/` is the package as the AUR wants it: it fetches the repository's
`development` branch and builds it, so `yay -Syu` (or `paru`) rebuilds Aoide
whenever there is a new commit. It only works once this repository is public —
the AUR has no way to reach a private one.

Users install it with:

```sh
yay -S aoide-git
```

## Publishing it (once, by hand — needs your AUR account)

1. Create an account at https://aur.archlinux.org and add your SSH public key
   under *My Account*.
2. On the Arch machine:

   ```sh
   git clone ssh://aur@aur.archlinux.org/aoide-git.git
   cp -r /path/to/aoide-desktop/packaging/aur/aoide-git/. aoide-git/
   cd aoide-git
   makepkg --printsrcinfo > .SRCINFO   # regenerates it from the PKGBUILD
   makepkg -si                          # prove it builds before publishing
   git add PKGBUILD .SRCINFO io.github.Virel0.Aoide.desktop
   git commit -m "Initial import"
   git push
   ```

3. From then on, a change to the PKGBUILD here is copied over and pushed the
   same way. A new commit to the app needs nothing: `-git` packages rebuild
   from whatever the branch holds.

## Why not a release package

A `-bin` package that installs a prebuilt release is quicker to install and is
the usual second step. It needs GitHub Releases carrying a built package first;
the app already looks at this repository's releases to announce updates, so
tagging releases is worth doing for that reason too.
