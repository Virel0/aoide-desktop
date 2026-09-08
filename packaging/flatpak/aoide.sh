#!/bin/sh
# Electron cannot use its own sandbox inside Flatpak's; zypak bridges the two.
# Without it the app either refuses to start or runs unsandboxed.
#
# --class is what makes the taskbar icon reliable: the desktop matches a window
# to its .desktop entry by WM_CLASS, and Electron would otherwise derive one
# that does not match this file's name.
exec zypak-wrapper /app/aoide/aoide --class=aoide "$@"
