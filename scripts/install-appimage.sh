#!/usr/bin/env bash
# install-appimage.sh — Integrate the Nexus AppImage with the system.
#
# This registers the app in the application launcher and registers the
# app.nexus.desktop:// and nexus:// URL schemes (needed for SSO callbacks).
#
# Usage:
#   ./install-appimage.sh [PATH_TO_APPIMAGE]
#
# If no path is given, the script looks for a Nexus-*.AppImage in the
# current directory.
#
# Requires: bash, unsquashfs (squashfs-tools), xdg-mime, update-desktop-database

set -euo pipefail

APPIMAGE="${1:-}"

# Auto-detect AppImage if not provided
if [[ -z "$APPIMAGE" ]]; then
    APPIMAGE=$(ls Nexus-*.AppImage 2>/dev/null | sort -V | tail -1 || true)
    if [[ -z "$APPIMAGE" ]]; then
        echo "Error: No Nexus AppImage found. Pass the path as an argument:" >&2
        echo "  $0 /path/to/Nexus-x.y.z.AppImage" >&2
        exit 1
    fi
fi

APPIMAGE=$(realpath "$APPIMAGE")

if [[ ! -f "$APPIMAGE" ]]; then
    echo "Error: File not found: $APPIMAGE" >&2
    exit 1
fi

echo "Installing: $APPIMAGE"

# Directories
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$APPS_DIR" "$ICONS_DIR"

# Find squashfs offset (AppImage type 2: squashfs starts after the ELF runtime)
OFFSET=$(python3 -c "
with open('$APPIMAGE', 'rb') as f:
    data = f.read(1024 * 1024)
idx = data.rfind(b'hsqs')
if idx == -1:
    idx = data.rfind(b'sqsh')
print(idx)
" 2>/dev/null)

if [[ -z "$OFFSET" || "$OFFSET" == "-1" ]]; then
    echo "Error: Could not find squashfs data in AppImage. Is this a valid Type 2 AppImage?" >&2
    exit 1
fi

# Extract squashfs to a temp dir
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Extracting AppImage metadata (offset=$OFFSET)…"
unsquashfs -q -o "$OFFSET" -d "$TMPDIR/sq" "$APPIMAGE" \
    '*.desktop' '*.png' 'usr/share/icons/*' 2>/dev/null || true

# Find the .desktop file
DESKTOP_SRC=$(find "$TMPDIR/sq" -maxdepth 1 -name "*.desktop" | head -1)
if [[ -z "$DESKTOP_SRC" ]]; then
    echo "Error: No .desktop file found in AppImage squashfs root." >&2
    exit 1
fi

DESKTOP_NAME=$(basename "$DESKTOP_SRC")
DESKTOP_DEST="$APPS_DIR/$DESKTOP_NAME"

# Write the .desktop file with the correct Exec path (pointing to the AppImage)
sed "s|^Exec=AppRun|Exec=$APPIMAGE|" "$DESKTOP_SRC" > "$DESKTOP_DEST"
echo "Installed: $DESKTOP_DEST"

# Install icon (512x512 PNG from the squashfs)
ICON_SRC=$(find "$TMPDIR/sq/usr/share/icons" -name "*.png" 2>/dev/null | head -1)
if [[ -n "$ICON_SRC" ]]; then
    ICON_NAME=$(basename "$ICON_SRC")
    cp "$ICON_SRC" "$ICONS_DIR/$ICON_NAME"
    echo "Installed icon: $ICONS_DIR/$ICON_NAME"
fi

# Register the .desktop file and update icon/MIME caches
update-desktop-database "$APPS_DIR" 2>/dev/null || true
gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# Register URL scheme handlers
for scheme in app.nexus.desktop nexus; do
    xdg-mime default "$DESKTOP_NAME" "x-scheme-handler/$scheme" 2>/dev/null && \
        echo "Registered URL scheme: $scheme://"
done

echo ""
echo "Done! Nexus is now integrated with your system."
echo "You may need to log out and back in (or run 'hash -r') for the protocol"
echo "handler to take effect in all applications."
