// @ts-check
// Feedback-Helfer: baut sichere, vorausgefüllte GitHub-Issue- & E-Mail-Links ohne Geheimnisse oder Chat-Daten.
const REPO = 'fischersase/aura';
const GITHUB_NEW_ISSUE = `https://github.com/${REPO}/issues/new`;

const KIND_META = {
  bug: { label: 'bug', prefix: '[Fehler]', heading: 'Fehlerbericht' },
  feature: { label: 'enhancement', prefix: '[Idee]', heading: 'Funktionswunsch' },
  feedback: { label: 'feedback', prefix: '[Feedback]', heading: 'Rückmeldung' }
};

/**
 * Erstellt die sichere Feedback-Nachricht + GitHub-Issue-URL (und optionalen Endpoint-Payload).
 * @param {{
 *   kind?: string,
 *   title?: string,
 *   message: string,
 *   includeSystemInfo?: boolean,
 *   context?: {
 *     version?: string,
 *     platform?: string,
 *     arch?: string,
 *     provider?: string,
 *     model?: string,
 *     hardwareSummary?: string
 *   }
 * }} input
 */
function buildFeedback(input) {
  const kindKey = input.kind && Object.prototype.hasOwnProperty.call(KIND_META, input.kind) ? input.kind : 'feedback';
  const meta = KIND_META[/** @type {keyof typeof KIND_META} */ (kindKey)];
  const rawMessage = String(input.message || '').trim();
  if (!rawMessage) throw new Error('Bitte schreib kurz dein Feedback oder dein Anliegen.');
  const rawTitle = String(input.title || '').trim();
  const shortFallback = rawMessage.split(/\r?\n/)[0].slice(0, 72);
  const fullTitle = `${meta.prefix} ${rawTitle || shortFallback}`.slice(0, 140);

  const lines = [`### ${meta.heading}`, '', rawMessage];
  if (input.includeSystemInfo !== false && input.context) {
    const c = input.context;
    lines.push(
      '',
      '---',
      '### System-Kontext (automatisch angehängt, ohne Schlüssel/Chats)',
      `- **Aura-Version:** ${c.version || '?'}`,
      `- **System:** ${c.platform || process.platform} (${c.arch || process.arch})`,
      `- **KI-Anbieter:** ${c.provider || '?'} (${c.model || '?'})`
    );
    if (c.hardwareSummary) lines.push(`- **Hardware:** ${c.hardwareSummary}`);
  }
  const body = lines.join('\n').slice(0, 6000);

  const params = new URLSearchParams({
    title: fullTitle,
    labels: `${meta.label},user-feedback`,
    body
  });
  const githubUrl = `${GITHUB_NEW_ISSUE}?${params.toString()}`;

  return {
    kind: kindKey,
    title: fullTitle,
    body,
    clipboardText: `${fullTitle}\n\n${body}`,
    githubUrl
  };
}

module.exports = { REPO, GITHUB_NEW_ISSUE, buildFeedback };
