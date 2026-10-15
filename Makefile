# Kurzbefehle für Aura
.PHONY: update local version prod-release

# Vollautomatisches Produktiv-Release (z. B. make prod-release, make prod-release BUMP=minor oder VERSION=0.14.0)
prod-release:
	@bash scripts/prod-release.sh "$(BUMP)" "$(VERSION)"

# Neueste Aura-Version für Ubuntu herunterladen, installieren und neu starten
update:
	@bash scripts/update-linux.sh

# Den Stand dieses Checkouts (z. B. Branch agent-v2) bauen und installieren, ohne auf ein Release zu warten
local:
	@bash scripts/update-linux.sh --local

# Installierte Version anzeigen
version:
	@dpkg-query -W -f='Aura $${Version}\n' aura-desktop 2>/dev/null || echo 'Aura ist nicht als .deb installiert.'

