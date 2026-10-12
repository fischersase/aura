#!/bin/bash
# Aura: Vorlage von electron-builder (app-builder-lib/templates/linux) plus Paketquelle; ${…} setzt electron-builder ein.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# ---------- Aura: Paketquelle für Updates (wie bei Chrome oder VS Code) ----------
# Danach bringt "sudo apt update && sudo apt upgrade" neue Aura-Versionen. Wer das nicht will:
# vor der Installation "echo AURA_APT_REPO=no | sudo tee /etc/default/aura".
# Nur eintragen, wenn die Quelle erreichbar ist (sonst bräche "apt update" ab); jedes spätere Update versucht es erneut.
AURA_APT_URL='https://fischersase.github.io/aura/apt'
aura_repo_online() {
  if hash curl 2>/dev/null; then curl -fsI --max-time 8 "$AURA_APT_URL/dists/stable/InRelease" >/dev/null 2>&1
  elif hash wget 2>/dev/null; then wget -q --spider --timeout=8 "$AURA_APT_URL/dists/stable/InRelease"
  else return 1; fi
}
if [ -d /etc/apt/sources.list.d ] && ! grep -qs '^AURA_APT_REPO=no' /etc/default/aura && aura_repo_online; then
  install -d -m 0755 /usr/share/keyrings
  cat > /usr/share/keyrings/aura-archive-keyring.asc <<'KEY'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEaszt9hYJKwYBBAHaRw8BAQdAVZgWyk/jQMLp9P1Gbkq1itGdljGtyVKEEMQ6
WT1qkie0PkF1cmEgUmVsZWFzZXMgPDEyMTQyODE2OStmaXNjaGVyc2FzZUB1c2Vy
cy5ub3JlcGx5LmdpdGh1Yi5jb20+iJkEExYKAEEWIQQtHIGWSR+ekqAE9K4QLq+x
f8hfkAUCaszt9gIbAwUJCWYBgAULCQgHAgIiAgYVCgkICwIEFgIDAQIeBwIXgAAK
CRAQLq+xf8hfkNuKAP9zv58jdt1JPRpo3c8X54RJXmf9dpOklU3eUQzI7Bz4zAD+
MmjdPFAPQdLGVZG8CpReSAQu4jO+XY0irtV42pWuVQ4=
=unTA
-----END PGP PUBLIC KEY BLOCK-----
KEY
  chmod 0644 /usr/share/keyrings/aura-archive-keyring.asc
  if [ ! -e /etc/apt/sources.list.d/aura.sources ]; then
    cat > /etc/apt/sources.list.d/aura.sources <<'SRC'
Types: deb
URIs: https://fischersase.github.io/aura/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/aura-archive-keyring.asc
SRC
    chmod 0644 /etc/apt/sources.list.d/aura.sources
  fi
fi
