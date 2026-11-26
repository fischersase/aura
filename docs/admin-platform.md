# Aura Admin Console & Observability Platform (Headhunter-Stack, 0 € Betriebskosten)

Dieses Dokument beschreibt Betrieb, Architektur und Deployment der **Aura Admin Console** auf deinem eigenen **k3s-Cluster** mit **Tailscale Funnel**, **PostgreSQL**, **Prometheus**, **Grafana** und automatischem **Jira-Feedback-Export** (OpenClaw-ready).

## 1. Architektur-Überblick

- **Aura Desktop Client** (`src/telemetry.js`, `src/redact.js`):
  - **Stufe 0 (Standard):** Rein lokal, nichts verlässt den PC.
  - **Stufe 1 (Opt-In im Setup / Einstellungen):** Anonyme Nutzungs- & Performance-Metriken (Latenzen, Tool-Erfolgsquoten, OS, Version, RAM/VRAM-Bucket).
  - **Stufe 2 (Opt-In im Setup / Einstellungen):** Geschwärzte Chat-History- & Agent-Protokolle (`scrubPii` entfernt lokal Keys, Passwörter, E-Mails, IBANs, Telefonnummern und Windows-/Linux-Benutzernamen in Pfaden).
  - **DSGVO Art. 17:** 1-Klick-Löschen aller gespeicherten Server-Protokolle direkt aus Aura.
  - **Direktes In-App-Feedback:** `#feedbackDialog` sendet direkt an `POST /api/ingest/feedback` (Windows-Nutzer brauchen keinen GitHub-Account mehr; GitHub bleibt Fallback).
- **Admin Backend (`admin/backend/`)**: Express + PostgreSQL + Prometheus `/metrics` + Google-OAuth-Admin-Login + Feedback-Triage/Dedupe/Jira-Export + Improvement Flywheel (Judge-Scoring, Auto-Clustering, 1-Klick `agent/evals/` Golden-Eval-Export, Canary-Proposals).
- **Admin Frontend (`admin/frontend/`)**: Material-3 / Google-Dev-Oberfläche in unprivileged Nginx (`port 8080`).
- **Monitoring (`k8s/monitoring/`)**: Prometheus (Pod-Discovery + `postgres-exporter`) + Grafana (`grafana_ro` Read-Only-Rolle ohne Zugriff auf Freitext-Feedback oder Admin-Sessions) + 3 vorprovisionierte Dashboards.
- **Tailscale Funnel (`k8s/overlays/{int,prod}/tailscale-funnel.yaml`)**: Öffentliche HTTPS-Adresse `https://aura-prod.tailc7b22c.ts.net` (Int: `https://aura-int.tailc7b22c.ts.net`) ohne Port-Forwarding oder Cloud-Kosten. Admin-Zugang strikt auf `ADMIN_BOOTSTRAP_EMAILS` (`fischer.sase@gmail.com`) beschränkt.

## 2. Lokal sofort starten (Docker Compose)

```bash
DEV_ADMIN_TOKEN=mein-dev-token docker compose -f docker-compose.admin.yml up --build
```

- **Aura Admin Console:** `http://127.0.0.1:8088` (Login mit `mein-dev-token`)
- **Grafana:** `http://127.0.0.1:3005` (`admin` / `local-dev-grafana`)
- **Prometheus:** `http://127.0.0.1:9095`
- In Aura (Einstellungen → Datenschutz & Telemetrie): als Admin-URL `http://127.0.0.1:8088` eintragen.

## 3. Produktiv-Deployment auf deinem k3s-Cluster (wie `headhunter`)

### Schritt 1: Docker-Images bauen & in k3s importieren
```bash
docker build -t aura-admin-backend:latest ./admin/backend
docker build -t aura-admin-frontend:latest ./admin/frontend
docker save aura-admin-backend:latest | sudo k3s ctr images import -
docker save aura-admin-frontend:latest | sudo k3s ctr images import -
```

### Schritt 2: Namespace & lokale K8s-Secrets einmalig anlegen (`aura-prod`)
```bash
KUBECONFIG=~/.kube/config kubectl create namespace aura-prod

PG_PW=$(openssl rand -hex 24)
GRAFANA_PW=$(openssl rand -hex 16)
GRAFANA_DB_PW=$(openssl rand -hex 24)

KUBECONFIG=~/.kube/config kubectl create secret generic aura-admin-secrets -n aura-prod \
  --from-literal=POSTGRES_PASSWORD="$PG_PW" \
  --from-literal=DATABASE_URL="postgres://aura_admin:${PG_PW}@postgres-service-prod:5432/aura_admin" \
  --from-literal=ADMIN_BOOTSTRAP_EMAILS="fischer.sase@gmail.com" \
  --from-literal=GOOGLE_CLIENT_ID="<deine-google-oauth-client-id>" \
  --from-literal=JIRA_EMAIL="<deine-atlassian-email>" \
  --from-literal=JIRA_API_TOKEN="<dein-atlassian-api-token>"

KUBECONFIG=~/.kube/config kubectl create secret generic grafana-secrets -n aura-prod \
  --from-literal=GRAFANA_ADMIN_PASSWORD="$GRAFANA_PW" \
  --from-literal=GRAFANA_DB_PASSWORD="$GRAFANA_DB_PW"

KUBECONFIG=~/.kube/config kubectl create secret generic tailscale-authkey -n aura-prod \
  --from-literal=authkey="tskey-auth-<dein-tailscale-key>"
```
*(Hinweis: `JIRA_EMAIL` und `JIRA_API_TOKEN` sind optional. Ohne sie bleiben Rückmeldungen sauber in der Admin-Inbox und werden automatisch nachgeholt, sobald du das Secret ergänzt.)*

### Schritt 3: Kustomize-Manifest anwenden
```bash
KUBECONFIG=~/.kube/config kubectl apply -k k8s/overlays/prod
KUBECONFIG=~/.kube/config kubectl get pods -n aura-prod
```

Nach ca. 30 Sekunden ist deine Admin Console unter `https://aura-prod.tailc7b22c.ts.net` erreichbar und Grafana lokal unter `http://grafana-aura-prod.local` (oder via `KUBECONFIG=~/.kube/config kubectl port-forward svc/grafana-prod 3005:3000 -n aura-prod` → `http://127.0.0.1:3005`).
