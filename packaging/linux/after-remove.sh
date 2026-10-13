#!/bin/bash
# Aura: Vorlage von electron-builder (app-builder-lib/templates/linux) plus Paketquelle; ${…} setzt electron-builder ein.
# shellcheck disable=SC2016  # '${executable}' etc. are build-time placeholders, filled in by electron-builder

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
# Aura: Paketquelle beim Entfernen löschen. Der Schlüssel ist eine Paketdatei und verschwindet mit dem Paket;
# eine Quelle ohne Schlüssel ließe "apt update" scheitern. (Bei einem Update ist $1 "upgrade": nichts tun.)
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  rm -f /etc/apt/sources.list.d/aura.sources
fi
