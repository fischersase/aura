# Kurzbefehle für Aura
.PHONY: update version

# Neueste Aura-Version für Ubuntu herunterladen, installieren und neu starten
update:
	@bash scripts/update-linux.sh

# Installierte Version anzeigen
version:
	@dpkg-query -W -f='Aura $${Version}\n' aura-desktop 2>/dev/null || echo 'Aura ist nicht als .deb installiert.'
